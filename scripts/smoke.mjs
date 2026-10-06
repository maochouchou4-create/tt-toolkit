#!/usr/bin/env node
/**
 * 冒烟机判：node 驱动 dist（storage 写读 roundtrip + host 适配层
 * API 探测清单逐项打印 + P1 时序回归）。
 *
 * 机制：module.register 挂 stub-loader（@sillytavern 外置说明符 → 内存
 * 存根），globalThis.__TT_SMOKE_STUBS__ 提供可变单例与函数桩；随后
 * import dist/index.js——其入口为唯一环境分支点，无 document 走冒烟
 * 分支：initStorage → 探测清单/roundtrip → nav 最小初始化 → nav dump。
 * 另含：启动管线末位 legacy-wipe 一次性清理（[wipe-smoke] 机判，
 * 预种 7 个旧遗留键验「迁移先于清理」）＋ boot2 二次启动（cache-buster
 * URL 整图重求值 dist，验标记短路 no-op 不炸）。
 * 退出码：探测/roundtrip/回归断言全 PASS 为 0，任一 FAIL 为 1。
 *
 * 边界：node 冒烟验证「产物可加载、导入链可解析、storage 逻辑正确、
 * 探测机制工作、初始化时序正确」；宿主真实在场性归浏览器验收（用户侧）。
 */

import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const DIST_ENTRY = new URL('../dist/index.js', import.meta.url);

if (!existsSync(fileURLToPath(DIST_ENTRY))) {
    console.error('[smoke] dist/index.js 不存在——先跑 pnpm build');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// localStorage 存根：node 无 localStorage。预种全部旧遗留键
// （迁移源键，带内容）——legacy-wipe 启动链路供给（boot 迁移先消费、
// boot 清理后删键）。persona 侧迁移键为 3 个（世界书勾选/钉选域已
// 退役）；nav 侧 tt_msg_nav_auto_top 键已随自动回顶开关退役、不再迁移，
// 仅作 wipe 删键计数供给。键名与 src/storage/legacy-wipe.ts
// 的常量表同源；此处字面量属测试夹具（机判断言在 dist 侧用常量做）。
// 种子形状含历史字段（如 pw_data_user_v1 的 hasResult）＝v1.0.0 时代的
// 真实输入形状，normalize 丢弃面验证所需，勿按现域形状「修正」。
// ---------------------------------------------------------------------------
const LEGACY_SEEDS = new Map([
    ['tt_msg_nav_auto_top', '0'],
    ['tt_nav_qr_activated', '1'],
    ['pw_state_v20', JSON.stringify({ localConfig: { stream: false, timeoutSec: 600 } })],
    ['pw_ui_state_v4_preset', JSON.stringify({ generationPreset: 'pure' })],
    ['pw_data_user_v1', JSON.stringify({ request: '启动链路种子', result: '启动链路种子·结果', hasResult: true })],
]);
const localStorageData = new Map(LEGACY_SEEDS);
globalThis.localStorage = {
    getItem: key => (localStorageData.has(key) ? localStorageData.get(key) : null),
    setItem: (key, value) => localStorageData.set(key, String(value)),
    removeItem: key => localStorageData.delete(key),
    clear: () => localStorageData.clear(),
};

// ---------------------------------------------------------------------------
// 宿主存根：与 src/host 导入面对齐（stub-loader.mjs 的 STUB_EXPORTS 表）
// ---------------------------------------------------------------------------

// 事件总线（可触发式）：on/once 记录监听器，emit 同步派发并
// 返回首个监听器的返回值——冒烟断言 MESSAGE_RECEIVED 守卫链/同步返回
// 语义靠它驱动（宿主真实 emit 串行 await 每个监听器，同步派发同构）
const eventHandlers = new Map();

// getContext 存根（稳定单例）：守卫链读楼层正文（chat 数组）需要
// 跨调用持久——每次新对象会让「往 chat 里放消息」这一动作失效
// externalPrompts 给自动注入面三个槽位——stub_anchor
// （depth 0 非空）、stub_blank（空白 value＝应被跳过）、stub_memory
// （depth 4 非空）——断言 depth 升序排序与「非空即带、空槽位跳过」
const stubContext = {
    chat: [],
    chatId: null,
    groupId: null,
    characterId: null,
    // 斜令执行器故意缺席：node 冒烟不模拟宿主执行
    executeSlashCommandsWithOptions: undefined,
    // chat 域立即保存通道（调用计数供断言：writeChatMetadata 是否真的走它）
    saveMetadata: async () => {
        globalThis.__TT_SMOKE_STUBS__.saveMetadataCalls++;
    },
    // openai 预设管理器存根：破限注入机判用——「冒烟破限」＝assistant 开场
    // ＋user 接话两条启用文本条目，附 marker 占位与停用条目各一（启用过滤/
    // 角色保真/marker 剔除的判据材料）；无 system 角色启用条目——persona
    // 预设文风通道（extractSystemParts）不受此桩影响仍归空
    getPresetManager: () => ({
        getPresetList: () => ({ preset_names: { '冒烟破限': 0 } }),
        getCompletionPresetByName: (name) => (name === '冒烟破限' ? {
            prompts: [
                { identifier: 'jb-open', role: 'assistant', content: '破限开场白' },
                { identifier: 'jb-marker', marker: true, content: '占位' },
                { identifier: 'jb-user', role: 'user', content: '破限接话' },
                { identifier: 'jb-off', role: 'system', content: '停用条目', enabled: false },
            ],
            prompt_order: [{ character_id: 100001, order: [
                { identifier: 'jb-open', enabled: true },
                { identifier: 'jb-marker', enabled: true },
                { identifier: 'jb-user', enabled: true },
                { identifier: 'jb-off', enabled: false },
            ] }],
        } : undefined),
    }),
    extensionPrompts: {
        // 插入序故意与 depth 序不同（memory 先插入但 depth 更深）——
        // 排序断言只有真的实现了 depth 排序才绿
        'stub_memory': { value: '【记忆摘要·stub】王玉已连续三天在子时到访旧货铺。', position: 0, depth: 4, scan: true, role: 0 },
        'stub_blank': { value: '   ', position: 0, depth: 2, scan: true, role: 0 },
        'stub_anchor': { value: '【锚点提示·stub】当前场景在旧货铺后院。', position: 0, depth: 0, scan: true, role: 0 },
    },
};

// 柏宝书 stub：在场即带口径的机判供给——
// getInjectedHistory 优先口径返回 relativeText（getHistory 降级路径
// 不触发；缺席路径由 choice-smoke 合成源传 null 覆盖）
globalThis.STBaiBaiBook = {
    apiVersion: 1,
    getInjectedHistory: () => ({ relativeText: '【柏宝书·stub】王玉与林霜曾在旧货铺发生过一场争执，此后两人各自回避提起。' }),
};

// 生成端点 fetch 桩（happy path）：固定回 4 条选项 JSON。流式 SSE 帧
// 形态（stream 恒开——TASK_DEFAULTS），content 走 delta 帧，与
// src/modules/apis/client.ts 的 callGenerateEndpoint 流式消费契约对齐
const FIXED_OPTIONS_JSON = JSON.stringify({
    options: [
        { title: '检查酒馆', content: '仔细检查酒馆的每个角落。' },
        { title: '打听消息', content: '向酒保打听最近的传闻。' },
        { title: '观察四周', content: '不动声色地观察酒馆里的人。' },
        { title: '起身离开', content: '找个借口离开酒馆。' },
    ],
});
const encoder = new TextEncoder();
globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: FIXED_OPTIONS_JSON } }] }),
    body: {
        getReader: () => {
            const frames = [
                encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: FIXED_OPTIONS_JSON } }] })}\n\n`),
                encoder.encode('data: [DONE]\n\n'),
            ];
            return { read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true } };
        },
    },
});

const noop = () => {};

globalThis.__TT_SMOKE_STUBS__ = {
    // settings 可变单例（roundtrip 载体；choice 导入断言往 .choice 里放 fixture）。
    // 预置存量 nav 域含退役字段 autoTop——P1 回归断言 boot prune 的判据材料
    extension_settings: {
        ttToolkit: { nav: { autoTop: false } },
    },
    chat_metadata: {},
    characters: [],
    this_chid: '0',
    // 全局 settings 防抖落盘（node 下 noop；roundtrip 只测内存写读链路）
    saveSettingsDebounced: noop,
    // 发送通道（node 冒烟不真发）
    sendTextareaMessage: async () => {},
    // 宏替换（恒等——冒烟下 {{user}} 等走引擎兜底值）
    substituteParams: text => text,
    // 请求头（node 下无 CSRF）
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    // 宿主通用注入槽位表（script.js 直导入面——空表；自动注入读取走
    // context 转发的 stubContext.extensionPrompts，见上）
    extension_prompts: {},
    // power_user（人设空——persona 注入模块按「未设置」路径走；
    // personas/persona_descriptions 桶在场：host/personas.ts 写回通道
    // 的防御性初始化走真实空桶路径）
    power_user: {
        persona_description: '',
        personas: {},
        persona_descriptions: {},
    },
    // 世界书激活（空桶——真实条目归浏览器验收）
    getWorldInfoPrompt: async () => ({
        worldInfoBefore: '',
        worldInfoAfter: '',
        worldInfoExamples: [],
        worldInfoDepth: [],
    }),
    // 事件总线（真实 API 面无 off，摘除监听为 removeListener）
    eventSource: {
        on: (type, handler) => {
            if (!eventHandlers.has(type)) eventHandlers.set(type, []);
            eventHandlers.get(type).push(handler);
        },
        once: (type, handler) => {
            // once 简化为 on：冒烟不发重复事件，无需摘除语义
            if (!eventHandlers.has(type)) eventHandlers.set(type, []);
            eventHandlers.get(type).push(handler);
        },
        emit: (type, ...args) => {
            const handlers = eventHandlers.get(type) ?? [];
            let first;
            let i = 0;
            for (const handler of handlers) {
                const result = handler(...args);
                if (i++ === 0) first = result;
            }
            return first;
        },
    },
    event_types: {
        APP_READY: 'app_ready',
        CHAT_CHANGED: 'chat_id_changed',
        MESSAGE_UPDATED: 'message_updated',
        MESSAGE_RECEIVED: 'message_received',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        SETTINGS_LOADED: 'settings_loaded',
        PERSONA_CREATED: 'persona_created',
        PERSONA_UPDATED: 'persona_updated',
    },
    // 斜令注册器（commands 表真实可查，探测项可验证）
    SlashCommandParser: {
        commands: {},
        addCommandObject(command) {
            globalThis.__TT_SMOKE_STUBS__.SlashCommandParser.commands[command.name] = command;
        },
    },
    SlashCommand: {
        fromProps: props => props,
    },
    // dragElement 存根：dist 顶层导入链需要它在场（壳挂载只在浏览器路径
    // 发生，node 冒烟不会真正调用）
    dragElement: noop,
    getContext: () => stubContext,
    saveMetadataCalls: 0,
    // ------------------------------------------------------------------
    // persona 通道存根（host/personas.ts / host/worldinfo.ts 导入面）
    // ------------------------------------------------------------------
    // script.js:680 default_user_avatar（createAvatarPersona 的素材头像）
    default_user_avatar: 'img/user-default.png',
    // personas.js：写回通道四件套（node 冒烟不真写宿主；调用计数供断言）
    personasCalls: { initPersona: 0, setUserAvatar: 0, getUserAvatars: 0 },
    user_avatar: 'user-default.png',
    initPersona: (avatarId, name, description) => {
        globalThis.__TT_SMOKE_STUBS__.personasCalls.initPersona++;
        globalThis.__TT_SMOKE_STUBS__.user_avatar = avatarId;
        globalThis.__TT_SMOKE_STUBS__.power_user.personas[avatarId] = name;
        globalThis.__TT_SMOKE_STUBS__.power_user.persona_descriptions[avatarId] = { description };
    },
    setUserAvatar: async () => {
        globalThis.__TT_SMOKE_STUBS__.personasCalls.setUserAvatar++;
    },
    getUserAvatars: async () => {
        globalThis.__TT_SMOKE_STUBS__.personasCalls.getUserAvatars++;
        return ['user-default.png'];
    },
    // utils.js:2724 findPersona（存档无同名 → 走建档路径）
    findPersona: () => null,
    // world-info.js 写侧（node 冒烟：空世界书＋条目 uid 计数器）
    worldinfoCalls: { loadWorldInfo: 0, createWorldInfoEntry: 0, saveWorldInfo: 0, reloadEditor: 0 },
    worldinfoEntryUid: 1000,
    loadWorldInfo: async name => {
        globalThis.__TT_SMOKE_STUBS__.worldinfoCalls.loadWorldInfo++;
        return { entries: {} , name };
    },
    createWorldInfoEntry: (name, data) => {
        globalThis.__TT_SMOKE_STUBS__.worldinfoCalls.createWorldInfoEntry++;
        const uid = ++globalThis.__TT_SMOKE_STUBS__.worldinfoEntryUid;
        data.entries[uid] = { uid };
        return data.entries[uid];
    },
    saveWorldInfo: async () => {
        globalThis.__TT_SMOKE_STUBS__.worldinfoCalls.saveWorldInfo++;
    },
    reloadEditor: () => {
        globalThis.__TT_SMOKE_STUBS__.worldinfoCalls.reloadEditor++;
    },
};

// ---------------------------------------------------------------------------
// 驱动 dist：main.ts 检测无 document 走冒烟分支并打印全部输出。
// 收集 stdout 行做机判断言（roundtrip PASS、nav __TT_TOOLKIT__.nav 在场）。
// ---------------------------------------------------------------------------
const outputLines = [];
const origLog = console.log;
const origInfo = console.info;
const origError = console.error;
const tap = (prefix) => (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    outputLines.push(line);
    if (prefix === 'log') origLog(line);
    else if (prefix === 'info') origInfo(line);
    else origError(line);
};
console.log = tap('log');
console.info = tap('info');
// console.error 同样收口——persona/choice 冒烟的 FAIL 收尾行走
// console.error（不打扰 stdout 的 PASS 流），收尾判据须能看到它
console.error = tap('error');

register('./stub-loader.mjs', import.meta.url);

try {
    await import(DIST_ENTRY);
} catch (e) {
    console.error('[smoke] dist/index.js 加载失败', e);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 等 node 冒烟分支收尾再断言：入口 `void main()` 是 fire-and-forget，动态
// import 的解析先于后台异步链完成。自动生成断言含 setTimeout 轮询（宏任务），
// 断言会抢在轮询前执行——截断输出。改为显式等收尾行（OK/FAIL）或超时；
// persona 冒烟排在 choice 之后——收尾判据盯末段 [persona-smoke]
// OK 行（choice 的 FAIL 行同样提前触发收口）。
// ---------------------------------------------------------------------------
const SMOKE_DONE_RE = l => l.startsWith('[persona-smoke] OK：') || l.includes('项 FAIL：');
const deadline = Date.now() + 15000;
while (!outputLines.some(SMOKE_DONE_RE) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
}
if (!outputLines.some(SMOKE_DONE_RE)) {
    console.error('[smoke] FAIL: node 冒烟分支未在 15s 内收尾（runChoiceSmoke/runPersonaSmoke 挂起？）');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 机判断言
// ---------------------------------------------------------------------------
const failures = [];

const roundtripLines = outputLines.filter(l => l.startsWith('[roundtrip:'));
if (roundtripLines.length === 0) {
    failures.push('未见 storage roundtrip 输出');
}
for (const line of roundtripLines) {
    if (!line.includes('PASS')) failures.push(`roundtrip 失败：${line}`);
}

if (!outputLines.some(l => l.includes('host API 探测清单'))) {
    failures.push('未见 host 探测清单输出');
}

const nav = globalThis.__TT_TOOLKIT__?.nav;
if (!nav || typeof nav.dump !== 'function') {
    failures.push('__TT_TOOLKIT__.nav 不在场或无 dump()');
} else if (!String(nav.dump()).includes('nav-')) {
    failures.push('nav dump 输出异常');
}

// P1 回归：存量 nav 域预置退役字段 autoTop → initStorage prune →
// boot 后 nav 域不含 autoTop（迁移收口：退役字段丢弃，与 persona 域收缩同纪律）
const navDomainAfterBoot = globalThis.__TT_SMOKE_STUBS__.extension_settings.ttToolkit?.nav;
if (!navDomainAfterBoot || typeof navDomainAfterBoot !== 'object' || 'autoTop' in navDomainAfterBoot) {
    failures.push('P1 回归失败：存量 nav 域退役字段 autoTop 未在 boot 时丢弃');
}

// node 最小初始化注册的 /ttnav-* 命令全集恰三条（ttnav-auto 已随自动
// 回顶开关退役——全集判别同时锁「漏注册」与「退役项复活」）
const ttnavRegistered = Object.keys(globalThis.__TT_SMOKE_STUBS__.SlashCommandParser.commands)
    .filter(c => c.startsWith('ttnav-'));
const ttnavExpected = ['ttnav-top', 'ttnav-prev', 'ttnav-next'];
if (ttnavRegistered.length !== 3 || !ttnavExpected.every(c => ttnavRegistered.includes(c))) {
    failures.push(`nav 命令注册异常（期望恰三条 ${ttnavExpected.join('/')}，实得：${ttnavRegistered.join(' ') || '无'}）`);
}

// 工具箱斜令在模块求值期注册（不依赖浏览器挂载路径）——QR 按钮入口的
// 契约断言：命令必须在任何挂载发生前就进入命令表
if (!('tt-toolbox' in globalThis.__TT_SMOKE_STUBS__.SlashCommandParser.commands)) {
    failures.push('模块求值期未注册 /tt-toolbox（QR「工具箱」按钮依赖此命令）');
}

// chat 域写入走立即保存通道（writeChatMetadata → getContext().saveMetadata）
if (globalThis.__TT_SMOKE_STUBS__.saveMetadataCalls < 1) {
    failures.push('writeChatMetadata 未触发 getContext().saveMetadata（chat 域立即保存链路未接通）');
}

// ---------------------------------------------------------------------------
// choice 机判：组装/解析（[choice-smoke] 输出行收口）＋全局口在场
// ---------------------------------------------------------------------------
// PASS 行数精确断言（丢断言必须红）：runChoiceSmoke 的 check() 调用数是
// 可数的——新增断言要同步 +N，删断言同理；阈值式断言（<N）锁不住丢断言。
// 期望构成：组装注入/解析回退＋解析守门＋常量请求形状＋runlog 接线＋池抽取
// 分布/池注入/自动生成守卫链，共 84。
const CHOICE_PASS_EXPECTED = 84;
const choicePassLines = outputLines.filter(l => l.startsWith('[choice-smoke] PASS'));
const choiceFailLines = outputLines.filter(l => l.startsWith('[choice-smoke] FAIL'));
if (choicePassLines.length !== CHOICE_PASS_EXPECTED || choiceFailLines.length > 0) {
    failures.push(`choice 机判异常：期望恰好 ${CHOICE_PASS_EXPECTED} 条 PASS，实际 ${choicePassLines.length} 条 / FAIL ${choiceFailLines.length} 条${choiceFailLines.length ? `（首条：${choiceFailLines[0]}）` : ''}`);
}

// dump 断言：组装 dump 全文出现在输出中，且关键注入段逐项可见
const dumpStart = outputLines.findIndex(l => l.startsWith('=== 组装 dump 全文 ==='));
if (dumpStart < 0) {
    failures.push('未见「组装 dump 全文」输出');
} else {
    const dumpBody = outputLines.slice(dumpStart).join('\n');
    // 池注入 dump 打印在组装 dump 之后（「池注入 dump」段），标记
    // 断言对「dumpStart 之后」的全量输出收口——两份 dump 都算数；
    // <pool_rules> 标记已删（池规则并入模板 <rules> 段）
    for (const marker of ['<persona>', '<character>', '<world_info>', '<current_scene>', '<direction>', '<external_memory>', '<pool_entries>', '<rules>']) {
        if (!dumpBody.includes(marker)) {
            failures.push(`组装 dump 缺少注入段标记 ${marker}`);
        }
    }
}

// 全局口 __TT_TOOLKIT__.prompts：dump/assemble/parseOptions 三件套在场
const promptsPort = globalThis.__TT_TOOLKIT__?.prompts;
if (!promptsPort || typeof promptsPort.dump !== 'function' || typeof promptsPort.parseOptions !== 'function' || typeof promptsPort.assemble !== 'function') {
    failures.push('__TT_TOOLKIT__.prompts 全局口不在场或接口不全（dump/assemble/parseOptions）');
}

// 回退确定性触发：畸形样本解析走回退路径且产出 4 条（choice-smoke 内部
// 已断言，这里锁输出行存在——机判判据独立可观测）
if (!outputLines.some(l => l.includes('畸形样本走回退路径') && l.includes('PASS'))) {
    failures.push('畸形样本回退路径断言未见 PASS 输出');
}

// debugForceRaw 生成管线接线：置开关跑完整 generateOptions、
// 断言跳过 API 直喂畸形样本且走回退解析——该分支构造上不 fetch，node
// 冒烟无网络依赖；开关与生成管线脱钩在此翻红
if (!outputLines.some(l => l.startsWith('[choice-smoke] PASS') && l.includes('debugForceRaw'))) {
    failures.push('debugForceRaw 生成管线机判未见 PASS 输出（开关未接生成路径或断言被删）');
}

// 提示词配置初始化：默认模板落进全局域 storage（choice
// 18 模块——inject_pool_rules 已删，反 OOC 要点并入 core_rules）。
// 存储形态 Record<taskKey, PromptConfig> 三任务键：choice 18 模块红线
// 不变，persona 两任务键在场（各 2 模块：wi/任务指令——preset 源已随任务级
// 预设选择退役；已退休的 persona_refine 任务键不在期望清单——存量配置
// 读侧出局，写回自然清除）
const promptDomain = (globalThis.__TT_SMOKE_STUBS__.extension_settings.ttToolkit ?? {}).promptConfigs;
const promptTaskKeys = promptDomain && typeof promptDomain === 'object' ? Object.keys(promptDomain) : [];
const promptChoiceModules = Array.isArray(promptDomain?.choice?.modules) ? promptDomain.choice.modules.length : -1;
const personaKeyOk = ['persona_curator', 'persona_gen'].every(k => Array.isArray(promptDomain?.[k]?.modules) && promptDomain[k].modules.length > 0);
if (promptTaskKeys.length !== 3 || promptChoiceModules !== 18 || !personaKeyOk) {
    failures.push(`默认提示词配置未正确初始化（期望 Record 三任务键、choice 18 模块；实际键 ${promptTaskKeys.join(',') || '无'}、choice 模块数 ${promptChoiceModules}）`);
}

// ---------------------------------------------------------------------------
// persona 机判：迁移/纯函数/api 形状/互斥（[persona-smoke] 行收口）
// ---------------------------------------------------------------------------
// PASS 行数精确断言（同 CHOICE_PASS_EXPECTED 纪律：丢断言必须红）。
// 期望构成 66 条：迁移 14（空启动/3 键搬入/localConfig 退役快照保留/形状/
// 退休键/legacy 快照/二次零重写/域在场仍清/域形状收缩/存量域退役字段丢弃
// 含 v1.3 endpointId＋localConfig 旧键，收编 4 条：统一表形状/去重＋id 重
// 映射/choice 域 v2 重写＋全局活动键提升/persona 域 v2 清洗）＋端点删除联动
// 清空 1＋prompts 6（三任务键齐备/choice 18 模块红线/persona 两任务默认形状/
// 旧数组一次写迁移/任务隔离开关/按任务恢复默认）＋persona 组装 3＋persona
// dump 观测口 2＋纯函数 5＋api 14（含 finish_reason=length 截断显式报错回归
// ＋破限预设解析 2：角色保真/marker·停用剔除、悬空名 null）＋e2e 7（含取消
// 通道 1：请求已发出后取消归类＋复位不误写；破限注入 2：两段前缀在场＋
// 悬空 fail-soft 不注入）＋worldbook·store 9＋会话感知 3
// （CHAT_CHANGED 重置开场白默认档＋emit 接线全链＋无开场白卡回落不注入）＋
// host 活取用回归 2（this_chid 跟随＋chat_metadata 换引用写读落当前对象）。
const PERSONA_PASS_EXPECTED = 66;
const personaPassLines = outputLines.filter(l => l.startsWith('[persona-smoke] PASS'));
const personaFailLines = outputLines.filter(l => l.startsWith('[persona-smoke] FAIL'));
if (personaPassLines.length !== PERSONA_PASS_EXPECTED || personaFailLines.length > 0) {
    failures.push(`persona 机判异常：期望恰好 ${PERSONA_PASS_EXPECTED} 条 PASS，实际 ${personaPassLines.length} 条 / FAIL ${personaFailLines.length} 条${personaFailLines.length ? `（首条：${personaFailLines[0]}）` : ''}`);
}

// ---------------------------------------------------------------------------
// legacy-wipe 机判：一次性清理（[wipe-smoke] 行收口，先于 persona
// smoke 跑——见 src/main.ts runNodeSmoke 接线）
// ---------------------------------------------------------------------------
// PASS 行数精确断言（同上纪律）。run1＝一次启动签名共 10 条：boot 5（键
// 全删/标记置位/persona userContext 种子存活/localConfig 种子存活（异于
// 缺省 stream/timeout——世界书钉选断言随域退役改判别式）/nav qrActivated
// 激活态存活——迁移先于清理的完整链路证明）＋场景A 4（重置重种后清理删 5
// 键＋置标＋persona/nav 域逐字节不变×2）＋场景B 1（标记短路键存活）。
const WIPE_PASS_EXPECTED_RUN1 = 10;
const wipePassLines = outputLines.filter(l => l.startsWith('[wipe-smoke] PASS'));
const wipeFailLines = outputLines.filter(l => l.startsWith('[wipe-smoke] FAIL'));
if (wipePassLines.length !== WIPE_PASS_EXPECTED_RUN1 || wipeFailLines.length > 0) {
    failures.push(`wipe 机判异常：期望恰好 ${WIPE_PASS_EXPECTED_RUN1} 条 PASS，实际 ${wipePassLines.length} 条 / FAIL ${wipeFailLines.length} 条${wipeFailLines.length ? `（首条：${wipeFailLines[0]}）` : ''}`);
}
// boot 位清理确实执行（非跳过）：首个 [legacy-wipe] 行＝删除 5/5 键
const firstWipeLog = outputLines.find(l => l.startsWith('[legacy-wipe]'));
if (!firstWipeLog || !firstWipeLog.includes('删除 5/5')) {
    failures.push(`boot 位一次性清理未执行或删键数异常（首行：${firstWipeLog ?? '无'}）`);
}

// ---------------------------------------------------------------------------
// 退休符号清零：generateRaw（宿主主 API 通道）整体删除——dist
// 产物出现任何一处都说明退休不彻底。apiSource/apiProfiles 不做字符串计
// 数：迁移收编必须按旧键名读旧档（「旧字段只读不写」纪律的读侧合法残
// 留），其退休由结构性断言保证（persona/choice smoke 断言迁移后域内无
// 这些键＋normalize 丢弃未知字段——重新引入为真实字段必翻红）
// ---------------------------------------------------------------------------
const distSource = readFileSync(DIST_ENTRY, 'utf8');
const generateRawCount = (distSource.match(/generateRaw/g) ?? []).length;
if (generateRawCount > 0) failures.push(`dist 产物残留退休符号 generateRaw（计数 ${generateRawCount}，期望 0）`);

// ---------------------------------------------------------------------------
// 二次启动（boot2）：cache-buster URL 对 dist 整图重求值（vite 单
// chunk 无代码分割）——同浏览器二次启动语义：extension_settings 存根与
// localStorage 跨 import 持久。标记已置位＋遗留键重种 → boot 清理须短路
// （首个 [legacy-wipe] 行＝跳过）→ run2 机判走二次启动签名 6 条 PASS。
// ---------------------------------------------------------------------------
const segmentStart = outputLines.length;
eventHandlers.clear(); // run1 监听器不跨图串扰（emit 派发表进程级共享）
for (const [k, v] of LEGACY_SEEDS) localStorageData.set(k, v);
try {
    await import(new URL('../dist/index.js?boot2', import.meta.url));
} catch (e) {
    console.error('[smoke] boot2 dist/index.js 加载失败', e);
    process.exit(1);
}
const deadline2 = Date.now() + 15000;
while (!outputLines.slice(segmentStart).some(SMOKE_DONE_RE) && Date.now() < deadline2) {
    await new Promise(r => setTimeout(r, 50));
}
const seg2 = outputLines.slice(segmentStart);
if (!seg2.some(SMOKE_DONE_RE)) {
    failures.push('boot2：node 冒烟分支未在 15s 内收尾（runChoiceSmoke/runPersonaSmoke 挂起？）');
}
if (seg2.some(l => l.includes('项 FAIL：'))) {
    failures.push(`boot2：出现 FAIL 收尾行（首条：${seg2.find(l => l.includes('项 FAIL：'))}）`);
}
const wipe2PassCount = seg2.filter(l => l.startsWith('[wipe-smoke] PASS')).length;
if (wipe2PassCount !== 6) {
    failures.push(`boot2 wipe 机判异常：期望 6 条 PASS（二次启动签名 1＋场景A 4＋场景B 1），实际 ${wipe2PassCount} 条`);
}
const firstWipe2Log = seg2.find(l => l.startsWith('[legacy-wipe]'));
if (!firstWipe2Log || !firstWipe2Log.includes('跳过')) {
    failures.push(`boot2 boot 位清理未短路（首行：${firstWipe2Log ?? '无'}）`);
}
const seg2ChoicePass = seg2.filter(l => l.startsWith('[choice-smoke] PASS')).length;
const seg2PersonaPass = seg2.filter(l => l.startsWith('[persona-smoke] PASS')).length;
if (seg2ChoicePass !== CHOICE_PASS_EXPECTED || seg2PersonaPass !== PERSONA_PASS_EXPECTED) {
    failures.push(`boot2 冒烟重跑计数异常：choice ${seg2ChoicePass}/${CHOICE_PASS_EXPECTED}、persona ${seg2PersonaPass}/${PERSONA_PASS_EXPECTED}`);
}
// 末态：一次性标记置位＋遗留键全清（直查存根 Map，不依赖日志）
const ttDomainEnd = globalThis.__TT_SMOKE_STUBS__.extension_settings.ttToolkit;
if (ttDomainEnd?.legacyWipeDone !== true) {
    failures.push(`boot2 末态标记未置位（legacyWipeDone=${String(ttDomainEnd?.legacyWipeDone)}）`);
}
const leftoverKeys = [...LEGACY_SEEDS.keys()].filter(k => localStorageData.has(k));
if (leftoverKeys.length > 0) {
    failures.push(`boot2 末态遗留键未清（${leftoverKeys.join('、')}）`);
}

if (failures.length > 0) {
    for (const f of failures) console.error(`[smoke] FAIL: ${f}`);
    process.exit(1);
}

console.log(`[smoke] OK：dist 加载成功，roundtrip ${roundtripLines.length} 条全 PASS，探测清单已打印，nav dump 口在场，P1 回归（存量 nav 域退役字段丢弃）与 chat 域立即保存链路均通过；choice 机判 ${choicePassLines.length} 条全 PASS（组装注入/解析回退＋池抽取分布/池注入/自动生成守卫链——单层池结构，条目自身 pinned/weight 为真值），__TT_TOOLKIT__.prompts 全局口在场（dump 按任务）；persona 机判 ${personaPassLines.length} 条全 PASS（迁移收编幂等/域形状收缩与 v1.1.0 存量域退役字段丢弃/三任务键/统一端点请求形状与 SSE/两段链端到端/生成可停止/破限注入前缀/store 互斥与显式保存点/CHAT_CHANGED 会话感知清空）；wipe 机判 ${wipePassLines.length} 条全 PASS（boot 删 5 键＋标记置位＋迁移数据存活证明/域零触碰/标记短路）；boot2 二次启动 no-op 通过（清理短路＋冒烟重跑 choice ${seg2ChoicePass}/persona ${seg2PersonaPass} 全 PASS）；退休符号 generateRaw dist 计数 0（apiSource/apiProfiles 由域结构断言保证退休）。`);
