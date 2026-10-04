#!/usr/bin/env node
/**
 * 批A 判据机判：node 驱动 dist（storage 写读 roundtrip + host 适配层
 * API 探测清单逐项打印 + P1 时序回归）。
 *
 * 机制：module.register 挂 stub-loader（@sillytavern 外置说明符 → 内存
 * 存根），globalThis.__TT_SMOKE_STUBS__ 提供可变单例与函数桩；随后
 * import dist/index.js——其入口为唯一环境分支点，无 document 走冒烟
 * 分支：initStorage → 探测清单/roundtrip → nav 最小初始化 → nav dump。
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
// localStorage 存根：node 无 localStorage；P1 回归预置旧 nav 键＝关态
// （'0'），验证「initStorage 迁移 → store 读到 false」的时序链路
// ---------------------------------------------------------------------------
const localStorageData = new Map([['tt_msg_nav_auto_top', '0']]);
globalThis.localStorage = {
    getItem: key => (localStorageData.has(key) ? localStorageData.get(key) : null),
    setItem: (key, value) => localStorageData.set(key, String(value)),
    removeItem: key => localStorageData.delete(key),
    clear: () => localStorageData.clear(),
};

// ---------------------------------------------------------------------------
// 宿主存根：与 src/host 导入面对齐（stub-loader.mjs 的 STUB_EXPORTS 表）
// ---------------------------------------------------------------------------

// 事件总线（批C 升级为可触发式）：on/once 记录监听器，emit 同步派发并
// 返回首个监听器的返回值——冒烟断言 MESSAGE_RECEIVED 守卫链/同步返回
// 语义靠它驱动（宿主真实 emit 串行 await 每个监听器，同步派发同构）
const eventHandlers = new Map();

// getContext 存根（批C 起稳定单例）：守卫链读楼层正文（chat 数组）需要
// 跨调用持久——每次新对象会让「往 chat 里放消息」这一动作失效
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
};

// 生成端点 fetch 桩（批C happy path）：固定回 4 条选项 JSON（非流式
// choices[0].message.content 形态——与 host/generate.ts 消费契约对齐）
const FIXED_OPTIONS_JSON = JSON.stringify({
    options: [
        { title: '检查酒馆', content: '仔细检查酒馆的每个角落。' },
        { title: '打听消息', content: '向酒保打听最近的传闻。' },
        { title: '观察四周', content: '不动声色地观察酒馆里的人。' },
        { title: '起身离开', content: '找个借口离开酒馆。' },
    ],
});
globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: FIXED_OPTIONS_JSON } }] }),
});

const noop = () => {};

globalThis.__TT_SMOKE_STUBS__ = {
    // settings 可变单例（roundtrip 载体；批C 导入断言往 .choice 里放 fixture）
    extension_settings: {},
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
    // 宿主通用注入槽位表（空表——真实占用归浏览器验收）
    extension_prompts: {},
    // power_user（人设空——persona 注入模块按「未设置」路径走；
    // 批D 起 personas/persona_descriptions 桶在场：host/personas.ts 写回通道
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
    // 批D persona 通道存根（host/personas.ts / host/worldinfo.ts 导入面）
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
// 收集 stdout 行做机判断言（roundtrip PASS、nav __TT_NAV__ 在场）。
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
// 批D：console.error 同样收口——persona/choice 冒烟的 FAIL 收尾行走
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
// import 的解析先于后台异步链完成。批B 时整条链是纯微任务（先于本脚本
// 断言排空，恰好全绿）；批C 自动生成断言含 setTimeout 轮询（宏任务），
// 断言会抢在轮询前执行——截断输出。改为显式等收尾行（OK/FAIL）或超时。
// 批D 起 persona 冒烟排在 choice 之后——收尾判据改盯末段 [persona-smoke]
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

const nav = globalThis.__TT_NAV__;
if (!nav || typeof nav.dump !== 'function') {
    failures.push('__TT_NAV__ 不在场或无 dump()');
} else if (!String(nav.dump()).includes('nav-')) {
    failures.push('nav dump 输出异常');
}

// P1 回归：预置旧键 'tt_msg_nav_auto_top'='0' → initStorage 迁移 →
// nav 初始化 → store 读透传应得 false（dump 面回显 autoTop=off）
if (nav && typeof nav.dump === 'function' && !String(nav.dump()).includes('autoTop=off')) {
    failures.push('P1 回归失败：旧键 tt_msg_nav_auto_top=0 未迁移为关态（nav dump 应显示 autoTop=off）');
}

// node 最小初始化确实注册了全部 /ttnav-* 命令
const registeredCommands = ['ttnav-top', 'ttnav-prev', 'ttnav-next', 'ttnav-auto']
    .filter(c => c in globalThis.__TT_SMOKE_STUBS__.SlashCommandParser.commands);
if (registeredCommands.length < 4) {
    failures.push(`nav 最小初始化未注册全部 /ttnav-* 命令（仅注册：${registeredCommands.join(' ') || '无'}）`);
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
// 批B 机判：choice 组装/解析（[choice-smoke] 输出行收口）＋全局口在场
// ---------------------------------------------------------------------------
// PASS 行数精确断言（丢断言必须红）：runChoiceSmoke 的 check() 调用数是
// 可数的——新增断言要同步 +N，删断言同理；阈值式断言（<N）锁不住丢断言。
// 批B 37 条＋批C 37 条（抽取分布 5/导入 9/注入 8/绑定 5/自动生成 10，含
// stub 在场 1 条）＝74；双复核修复轮 +3（pinned≥count 覆盖语义、
// safeWeight fork 语义、非数字 messageId 跳过）＝77；批C.2 只读化 +11
//（asset 静态形状 7＋同步行为 4）＝88；反馈轮 +1（asset v2 条目规则全移除）
// ＝89；m03359 整合轮 +1（few-shot 7 条计数）＝90（注入区 9 条不变：删
// pool_rules 分层/空规则两断言，加池规则并入/模块移除两断言）；整合轮II
// +1（PoolBackup v2 备份升格断言：v1 apis→统一端点表＋choiceTask 派生）
// ＝91。
const CHOICE_PASS_EXPECTED = 91;
const choicePassLines = outputLines.filter(l => l.startsWith('[choice-smoke] PASS'));
const choiceFailLines = outputLines.filter(l => l.startsWith('[choice-smoke] FAIL'));
if (choicePassLines.length !== CHOICE_PASS_EXPECTED || choiceFailLines.length > 0) {
    failures.push(`choice 机判异常：期望恰好 ${CHOICE_PASS_EXPECTED} 条 PASS，实际 ${choicePassLines.length} 条 / FAIL ${choiceFailLines.length} 条${choiceFailLines.length ? `（首条：${choiceFailLines[0]}）` : ''}`);
}

// 批B 判据的 dump 断言：组装 dump 全文出现在输出中，且关键注入段逐项可见
const dumpStart = outputLines.findIndex(l => l.startsWith('=== 组装 dump 全文 ==='));
if (dumpStart < 0) {
    failures.push('未见「组装 dump 全文」输出');
} else {
    const dumpBody = outputLines.slice(dumpStart).join('\n');
    // 批C 起池注入 dump 打印在批B dump 之后（「池注入 dump」段），标记
    // 断言对「dumpStart 之后」的全量输出收口——两份 dump 都算数；
    // m03359：<pool_rules> 标记删除（池规则并入模板 <rules> 段）
    for (const marker of ['<persona>', '<character>', '<world_info>', '<current_scene>', '<direction>', '<external_memory>', '<pool_entries>', '<rules>']) {
        if (!dumpBody.includes(marker)) {
            failures.push(`组装 dump 缺少注入段标记 ${marker}`);
        }
    }
}

// 全局口 __TTK_PROMPTS__：dump/assemble/parseOptions 三件套在场
const promptsPort = globalThis.__TTK_PROMPTS__;
if (!promptsPort || typeof promptsPort.dump !== 'function' || typeof promptsPort.parseOptions !== 'function' || typeof promptsPort.assemble !== 'function') {
    failures.push('__TTK_PROMPTS__ 全局口不在场或接口不全（dump/assemble/parseOptions）');
}

// 回退确定性触发：畸形样本解析走回退路径且产出 4 条（choice-smoke 内部
// 已断言，这里锁输出行存在——机判判据独立可观测）
if (!outputLines.some(l => l.includes('畸形样本走回退路径') && l.includes('PASS'))) {
    failures.push('畸形样本回退路径断言未见 PASS 输出');
}

// debugForceRaw 生成管线接线（批B 判据）：置开关跑完整 generateOptions、
// 断言跳过 API 直喂畸形样本且走回退解析——该分支构造上不 fetch，node
// 冒烟无网络依赖；开关与生成管线脱钩在此翻红
if (!outputLines.some(l => l.startsWith('[choice-smoke] PASS') && l.includes('debugForceRaw'))) {
    failures.push('debugForceRaw 生成管线机判未见 PASS 输出（开关未接生成路径或断言被删）');
}

// 提示词配置初始化：默认模板落进全局域 storage（m03359 整合轮起 choice
// 18 模块——inject_pool_rules 已删，反 OOC 要点并入 core_rules）。整合轮II
// 起存储升级为 Record<taskKey, PromptConfig> 四任务键：choice 18 模块红线
// 不变，persona 三任务键在场（各 4 模块：preset/wi/任务指令）
const promptDomain = (globalThis.__TT_SMOKE_STUBS__.extension_settings.ttToolkit ?? {}).promptConfigs;
const promptTaskKeys = promptDomain && typeof promptDomain === 'object' ? Object.keys(promptDomain) : [];
const promptChoiceModules = Array.isArray(promptDomain?.choice?.modules) ? promptDomain.choice.modules.length : -1;
const personaKeyOk = ['persona_curator', 'persona_gen', 'persona_refine'].every(k => Array.isArray(promptDomain?.[k]?.modules) && promptDomain[k].modules.length > 0);
if (promptTaskKeys.length !== 4 || promptChoiceModules !== 18 || !personaKeyOk) {
    failures.push(`默认提示词配置未正确初始化（期望 Record 四任务键、choice 18 模块；实际键 ${promptTaskKeys.join(',') || '无'}、choice 模块数 ${promptChoiceModules}）`);
}

// ---------------------------------------------------------------------------
// 批D 机判：persona 迁移/纯函数/api 形状/互斥（[persona-smoke] 行收口）
// ---------------------------------------------------------------------------
// PASS 行数精确断言（同 CHOICE_PASS_EXPECTED 纪律：丢断言必须红）。
// 批D 41 条 → 整合轮II 重写为 60 条（统一 API 层＋提示词引擎多任务化）：
// 迁移 12（批D 9 条保留骨架：空启动/5 键搬入/形状/退休键/legacy 快照/
// 二次零重写/域在场仍清，过渡透传改实际 v2 透传形状＋新增收编 4 条：
// 统一表形状/去重＋id 重映射/choice 域 v2 重写/persona localConfig v2）＋
// prompts 7（四任务键齐备/choice 18 模块红线/persona 三任务默认形状/
// refine-gen 同文/旧数组一次写迁移/任务隔离开关/按任务恢复默认）＋
// persona 组装 5＋persona dump 观测口 2＋纯函数 8（批D 原样保留）＋
// api 11（buildGenerateBody 三档/显式参数/effort/SSE——改走统一客户端
// 公共面）＋e2e 4（store.generate 两段链走统一端点：请求形状/curator 段
// 标记/personaGen 段标记/结果落框）＋worldbook·store 12（批D 骨架保留；
// 主 API 缺席检查改端点缺失 fail fast，互斥改 lastRun 不变口径）。
const PERSONA_PASS_EXPECTED = 60;
const personaPassLines = outputLines.filter(l => l.startsWith('[persona-smoke] PASS'));
const personaFailLines = outputLines.filter(l => l.startsWith('[persona-smoke] FAIL'));
if (personaPassLines.length !== PERSONA_PASS_EXPECTED || personaFailLines.length > 0) {
    failures.push(`persona 机判异常：期望恰好 ${PERSONA_PASS_EXPECTED} 条 PASS，实际 ${personaPassLines.length} 条 / FAIL ${personaFailLines.length} 条${personaFailLines.length ? `（首条：${personaFailLines[0]}）` : ''}`);
}

// ---------------------------------------------------------------------------
// 整合轮II 退休符号清零：generateRaw（宿主主 API 通道）整体删除——dist
// 产物出现任何一处都说明退休不彻底。apiSource/apiProfiles 不做字符串计
// 数：迁移收编必须按旧键名读旧档（「旧字段只读不写」纪律的读侧合法残
// 留），其退休由结构性断言保证（persona/choice smoke 断言迁移后域内无
// 这些键＋normalize 丢弃未知字段——重新引入为真实字段必翻红）
// ---------------------------------------------------------------------------
const distSource = readFileSync(DIST_ENTRY, 'utf8');
const generateRawCount = (distSource.match(/generateRaw/g) ?? []).length;
if (generateRawCount > 0) failures.push(`dist 产物残留退休符号 generateRaw（计数 ${generateRawCount}，期望 0）`);

if (failures.length > 0) {
    for (const f of failures) console.error(`[smoke] FAIL: ${f}`);
    process.exit(1);
}

console.log(`[smoke] OK：dist 加载成功，roundtrip ${roundtripLines.length} 条全 PASS，探测清单已打印，nav dump 口在场，P1 时序回归（旧关态迁移）与 chat 域立即保存链路均通过；choice 机判 ${choicePassLines.length} 条全 PASS（批B 组装注入/解析回退＋批C 池抽取分布/导入往返/池注入/绑定级联/自动生成守卫链，备份 v2 升格），__TTK_PROMPTS__ 全局口在场（dump 按任务）；persona 机判 ${personaPassLines.length} 条全 PASS（整合轮II：迁移收编幂等/prompts 四任务键/统一端点请求形状与 SSE/两段链端到端/store 互斥与显式保存点）；退休符号 generateRaw dist 计数 0（apiSource/apiProfiles 由域结构断言保证退休）。`);
