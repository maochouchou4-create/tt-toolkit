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
 * URL 整图重求值 dist，验标记短路 no-op 不炸）。两轮各自等生产侧的 boot
 * 收尾标记 `[node-smoke] BOOT DONE boot=<id>` 才开始取断言（等不到即硬
 * 失败），不靠正文行猜「跑完了没」。
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
// 跨调用持久——每次新对象会让「往 chat 里放消息」这一动作失效。
// chat 是可换装属性（整体替换 stubContext.chat 后 emit CHAT_CHANGED
// 即模拟切聊天）；saveChat 为消息 extra 落盘通道存根（计数供断言）
// externalPrompts 给自动注入面三个槽位——stub_anchor
// （depth 0 非空）、stub_blank（空白 value＝应被跳过）、stub_memory
// （depth 4 非空）——断言 depth 升序排序与「非空即带、空槽位跳过」
// openai 预设管理器存根类（与宿主 preset-manager.js 同构）：两个方法都是
// class 方法——getCompletionPresetByName 内部必须走 this.getPresetList()，
// 与宿主 :777 → :549 的 this 依赖链同构（禁改回箭头函数/属性箭头）
class PresetManagerStub {
    constructor(presets, presetNames) {
        this._presets = presets;
        this._presetNames = presetNames;
    }
    getPresetList() { return { presets: this._presets, preset_names: this._presetNames, settings: {} }; }
    getCompletionPresetByName(name) {
        const { presets, preset_names } = this.getPresetList();
        const idx = preset_names[name];
        return idx === undefined ? undefined : presets[idx];
    }
}

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
    // 消息级落盘通道（调用计数供断言：writeFloorOptions 是否真的走它）
    saveChat: async () => {
        globalThis.__TT_SMOKE_STUBS__.saveChatCalls++;
    },
    // openai 预设管理器存根：与宿主同构的 class 实例——宿主
    // getCompletionPresetByName 内部走 this.getPresetList()，箭头函数替身
    // 不接受 this，曾让「宿主 this 丢失」缺陷在冒烟里全绿漏测。
    // 「冒烟破限」＝assistant 开场＋user 接话两条启用文本条目，附 marker
    // 占位与停用条目各一（启用过滤/角色保真/marker 剔除的判据材料）；
    // 无 system 角色启用条目——persona 预设文风通道（extractSystemParts）
    // 不受此桩影响仍归空
    getPresetManager: () => new PresetManagerStub(
        [{
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
        }],
        { '冒烟破限': 0 },
    ),
    extensionPrompts: {
        // 插入序故意与 depth 序不同（memory 先插入但 depth 更深）——
        // 排序断言只有真的实现了 depth 排序才绿
        'stub_memory': { value: '【记忆摘要·stub】王玉已连续三天在子时到访旧货铺。', position: 0, depth: 4, scan: true, role: 0 },
        'stub_blank': { value: '   ', position: 0, depth: 2, scan: true, role: 0 },
        'stub_anchor': { value: '【锚点提示·stub】当前场景在旧货铺后院。', position: 0, depth: 0, scan: true, role: 0 },
    },
    // 注入槽写入通道（script.js:10647 写入形态同构：{value, position,
    // depth, scan, role}；保留接收者的方法形态供 summary 槽挂载调用）
    setExtensionPrompt(key, value, position, depth, scan, role) {
        stubContext.extensionPrompts[key] = { value, position, depth, scan: scan === true, role: role ?? 0 };
    },
};

// 柏宝书 stub：在场即带口径的机判供给——
// getInjectedHistory 优先口径返回 relativeText（getHistory 降级路径
// 不触发；缺席路径由 choice-smoke 合成源传 null 覆盖）
globalThis.STBaiBaiBook = {
    apiVersion: 1,
    getInjectedHistory: () => ({ relativeText: '【柏宝书·stub】王玉与林霜曾在旧货铺发生过一场争执，此后两人各自回避提起。' }),
};

// 生成端点 fetch 桩（按请求体分发）：choice 形状（temperature 1.0＋
// response_format json_object）回固定 4 条选项 JSON；summary 形状
// （temperature 0.7、无契约键）回定稿测试摘要文本——两任务不能共用
// 固定回包（summary 请求吃到选项 JSON 会被空白守门之外的形状误判吞掉）。
// 流式 SSE 帧形态（stream 恒开——TASK_PARAMS），content 走 delta 帧，
// 与 src/modules/apis/client.ts 的 callGenerateEndpoint 流式消费契约对齐。
// 每次调用的 {url, body} 记入 __TT_SMOKE_STUBS__.generateCalls 供
// summary 冒烟断言请求形状（choice/persona 冒烟各自装私有桩，不读它）。
const FIXED_OPTIONS_JSON = JSON.stringify({
    options: [
        { title: '检查酒馆', content: '仔细检查酒馆的每个角落。' },
        { title: '打听消息', content: '向酒保打听最近的传闻。' },
        { title: '观察四周', content: '不动声色地观察酒馆里的人。' },
        { title: '起身离开', content: '找个借口离开酒馆。' },
    ],
});
const SUMMARY_REPLY_TEXT = '王玉与林霜在旧货铺重逢，谈起初见；两人约定三日后同去钟楼，关系就此缓和。';
const encoder = new TextEncoder();
function sseResponse(content) {
    return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
        body: {
            getReader: () => {
                const frames = [
                    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
                    encoder.encode('data: [DONE]\n\n'),
                ];
                return {
                    read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true },
                    // 与宿主同构：真实 ReadableStreamDefaultReader 带 cancel，
                    // 被放弃的流由传输层显式关闭（缺它会让那条路径在桩上抛
                    // TypeError 并盖掉原始错误）
                    cancel: async () => undefined,
                };
            },
        },
    };
}
globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    globalThis.__TT_SMOKE_STUBS__.generateCalls.push({ url: String(_url), body });
    // 0.7 与 TASK_PARAMS.summary_small.defaultTemperature 同值锚定＋e2e 请求形状断言互锁：
    // 参数日后改值时 e2e 断言（temperature===0.7）与本分发同步翻红，不是静默漂移。
    const isSummary = body.temperature === 0.7 && !('response_format' in body);
    return sseResponse(isSummary ? SUMMARY_REPLY_TEXT : FIXED_OPTIONS_JSON);
};

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
    // i18n 翻译（模拟 zh-cn 环境：让宿主错误标签的同源计算路径可测）
    translate: text => (text === 'API Error' ? 'API 错误' : text),
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
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_DELETED: 'message_deleted',
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
    saveChatCalls: 0,
    // fetch 桩调用记录（summary 冒烟断言请求形状用；其他段自装私有桩不读它）
    generateCalls: [],
    // ------------------------------------------------------------------
    // persona 通道存根（host/personas.ts / host/worldinfo.ts 导入面）
    // ------------------------------------------------------------------
    // script.js:680 default_user_avatar（createAvatarPersona 的素材头像）
    default_user_avatar: 'img/user-default.png',
    // personas.js：写回通道（node 冒烟不真写宿主；调用计数与入参日志供断言）
    // getUserAvatarsLog 记 (doRender, openPageAt)——渲染调用与幽灵键防御的
    // 取名调用同走一个函数，只有入参能分辨哪次是刷列表
    personasCalls: { initPersona: 0, setUserAvatar: 0, setPersonaDescription: 0, getUserAvatarsLog: [] },
    // 头像文件表（宿主 getUserAvatars 的真源）：power_user.personas 的键只有
    // 在表内才算有 PNG 落盘，否则 cleanGhostPersonaKeys 的幽灵键防御会把它
    // 当旧插件脏数据删掉。预置两张——覆盖分支的 setUserAvatar 静默切换面
    // 需要一张非选中头像才可达
    personaAvatarFiles: ['user-default.png', 'user-other.png'],
    // 选中态刻意不做活绑定（未进 stub-loader 的 LIVE_LET_NAMES）：宿主
    // initPersona（personas.js:548-570）只写 personas/persona_descriptions，
    // 切选中态是 setUserAvatar 的活绑定职责。这里给一个 const 快照，
    // 模块侧读到的选中态恒为本值——桩模拟的是「建档不动选中态」这一宿主
    // 真实语义；把它活起来只会让断言读到一个桩自己造的中间态
    user_avatar: 'user-default.png',
    initPersona: (avatarId, name, description) => {
        globalThis.__TT_SMOKE_STUBS__.personasCalls.initPersona++;
        globalThis.__TT_SMOKE_STUBS__.power_user.personas[avatarId] = name;
        globalThis.__TT_SMOKE_STUBS__.power_user.persona_descriptions[avatarId] = { description };
    },
    setUserAvatar: async () => {
        globalThis.__TT_SMOKE_STUBS__.personasCalls.setUserAvatar++;
    },
    setPersonaDescription: () => {
        globalThis.__TT_SMOKE_STUBS__.personasCalls.setPersonaDescription++;
    },
    getUserAvatars: async (doRender, openPageAt) => {
        globalThis.__TT_SMOKE_STUBS__.personasCalls.getUserAvatarsLog.push([doRender === true, String(openPageAt ?? '')]);
        return [...globalThis.__TT_SMOKE_STUBS__.personaAvatarFiles];
    },
    // utils.js:2724 findPersona（按 personas 真源 {头像id: 显示名} 按名查；
    // 恒 null 时 upsertPersona 只有建档分支可达，覆盖分支的写回纪律无从机判）
    findPersona: ({ name = null } = {}) => {
        const personas = globalThis.__TT_SMOKE_STUBS__.power_user.personas;
        const hit = Object.entries(personas).find(([, value]) => value === name);
        return hit ? { avatar: hit[0] } : null;
    },
    // world-info.js（node 冒烟：空世界书——生成参考链装载用）
    loadWorldInfo: async name => {
        return { entries: {}, name };
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
// 等 node 冒烟分支的 boot 收尾标记再断言：入口 `void main()` 是
// fire-and-forget，动态 import 的解析先于后台异步链完成。
//
// 判据只能是生产侧的收尾标记，不能拿正文行猜「跑完了没」：任一模块提前
// 出红（形如 `[xxx-smoke] N 项 FAIL：`）都会立刻触发这类猜测判据，断言
// 于是抢在串行冒烟链跑完前开跑，boot2 的段起点也取在偏早的位置——
// boot2 与未收尾的 boot1 并发跑、共用同一份宿主存根，真 FAIL 落在计数
// 区间之外，计出「FAIL 0 条」的假绿。故只认 src/main.ts runNodeSmoke
// 末位发出的 `[node-smoke] BOOT DONE boot=<id>`。
//
// 等不到标记＝硬失败：超时后继续断言，等于把「没跑完」当「跑完了」，
// 正是本判据要根除的那条路径。
// ---------------------------------------------------------------------------
const BOOT_DONE_PREFIX = '[node-smoke] BOOT DONE boot=';
const BOOT_TIMEOUT_MS = 15000;

/** 段内 boot 收尾标记的行号；未发出记 -1。 */
function bootDoneIndex(from, bootId) {
    const prefix = BOOT_DONE_PREFIX + bootId;
    for (let i = from; i < outputLines.length; i++) {
        if (outputLines[i].startsWith(prefix)) return i;
    }
    return -1;
}

/**
 * 等本 boot 的收尾标记，返回标记行号＝本 boot 行段的闭端。
 * 行序以 outputLines 的 push 序（console 调用序）为准，与 stdout/stderr
 * 交错写同一文件后的文件行序无关。
 */
async function waitForBootDone(from, bootId) {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (bootDoneIndex(from, bootId) < 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
    }
    const end = bootDoneIndex(from, bootId);
    if (end < 0) {
        console.error(`[smoke] FAIL: ${bootId} 未在 ${BOOT_TIMEOUT_MS / 1000}s 内发出收尾标记「${BOOT_DONE_PREFIX}${bootId}」（runChoiceSmoke/runPersonaSmoke/runSummarySmoke/runApisSmoke 挂起？）`);
        process.exit(1);
    }
    return end;
}

const boot1End = await waitForBootDone(0, 'boot1');
const boot1Lines = outputLines.slice(0, boot1End);

// ---------------------------------------------------------------------------
// 机判断言
// ---------------------------------------------------------------------------
const failures = [];

// 模块机判出红的机器口径（boot1/boot2 两段共用一份定义）：各模块 check()
// 逐条打 `[xxx-smoke] FAIL <断言名>`，收尾的 `[xxx-smoke] N 项 FAIL：` 只是
// 同一批失败的复述行。取逐条行（FAIL 后带空格＝断言名）既不含复述行的重复
// 计数，也保住首条明细。
const MODULE_FAIL_LINE = tag => l => l.startsWith(`[${tag}-smoke] FAIL `);

const roundtripLines = boot1Lines.filter(l => l.startsWith('[roundtrip:'));
if (roundtripLines.length === 0) {
    failures.push('未见 storage roundtrip 输出');
}
for (const line of roundtripLines) {
    if (!line.includes('PASS')) failures.push(`roundtrip 失败：${line}`);
}

if (!boot1Lines.some(l => l.includes('host API 探测清单'))) {
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

// 消息级落盘的链路口径在 runFloorPersistChecks 内以 delta 断言收口
// （writeFloorOptions 调用前后 saveChatCalls 恰 +1）——此处不再设全局
// 弱门：任何生成成功都会写楼层存档，弱门会被别处用例满足而失去判别力。

// ---------------------------------------------------------------------------
// choice 机判：组装/解析（[choice-smoke] 输出行收口）＋全局口在场
// ---------------------------------------------------------------------------
// PASS 行数精确断言（丢断言必须红）：runChoiceSmoke 的 check() 调用数是
// 可数的——新增断言要同步 +N，删断言同理；阈值式断言（<N）锁不住丢断言。
// 期望构成＝v1.5.17 基数 107 ＋ 选项元素级重构新增 13（解析/锚点 6、守门
// 对象形态与样本族汇总 2、runlog partial 遥测 1、楼层落盘 4）
// ＝ v1.5.19 零选项文案分支 3（真空响应/非 empty 原口径/正文非空但不抽选项）
// ＋ expectMessage=null 显式不校验 1
// ＋ 解析尾部分流六形态新增 5（收口散文/收口无锚点残渣/收口后垃圾/两份契约串接/缺分隔符）
// ＋ 空白正文单点判据 1（纯空白同走「未返回内容」分支——共享谓词的判别样本）
// ＝ 130。
// 不从「分组小计」加总推：分组基数随每批增长，抄旧小计必算错（下次 bump
// 只改本行等式右侧总数与该批 +N）。
// ＝ v1.9.0 任务模型卡新增 8（任务路由 fail fast 三态 3＋写档带出 1＋
// 缺席默认档 1＋normalize 钳制/剔除 3）
// ＝ v1.14.1 删权重死代码：E-S 加权分布/safeWeight/无停用条目 −3，等权均摊断言 +1
const CHOICE_PASS_EXPECTED = 137;
const choicePassLines = boot1Lines.filter(l => l.startsWith('[choice-smoke] PASS'));
const choiceFailLines = boot1Lines.filter(MODULE_FAIL_LINE('choice'));
if (choicePassLines.length !== CHOICE_PASS_EXPECTED || choiceFailLines.length > 0) {
    failures.push(`choice 机判异常：期望恰好 ${CHOICE_PASS_EXPECTED} 条 PASS，实际 ${choicePassLines.length} 条 / FAIL ${choiceFailLines.length} 条${choiceFailLines.length ? `（首条：${choiceFailLines[0]}）` : ''}`);
}

// dump 断言：组装 dump 全文出现在输出中，且关键注入段逐项可见
const dumpStart = boot1Lines.findIndex(l => l.startsWith('=== 组装 dump 全文 ==='));
if (dumpStart < 0) {
    failures.push('未见「组装 dump 全文」输出');
} else {
    const dumpBody = boot1Lines.slice(dumpStart).join('\n');
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
if (!boot1Lines.some(l => l.includes('畸形样本走回退路径') && l.includes('PASS'))) {
    failures.push('畸形样本回退路径断言未见 PASS 输出');
}

// debugForceRaw 生成管线接线：置开关跑完整 generateOptions、
// 断言跳过 API 直喂畸形样本且走回退解析——该分支构造上不 fetch，node
// 冒烟无网络依赖；开关与生成管线脱钩在此翻红
if (!boot1Lines.some(l => l.startsWith('[choice-smoke] PASS') && l.includes('debugForceRaw'))) {
    failures.push('debugForceRaw 生成管线机判未见 PASS 输出（开关未接生成路径或断言被删）');
}

// 提示词配置初始化：默认模板落进全局域 storage（choice
// 18 模块——inject_pool_rules 已删，反 OOC 要点并入 core_rules）。
// 存储形态 Record<taskKey, PromptConfig> 五任务键：choice 18 模块红线
// 不变，persona 两任务键在场（各 2 模块：wi/任务指令——preset 源已随任务级
// 预设选择退役；已退休的 persona_refine 任务键不在期望清单——存量配置
// 读侧出局，写回自然清除），summary 两任务键在场（任务指令＋源文本注入；
// 已退休的 summary_judge 任务键不在期望清单——存量配置读侧出局，
// DEFAULTS_VERSION 重建后写回自然清除）。
const promptDomain = (globalThis.__TT_SMOKE_STUBS__.extension_settings.ttToolkit ?? {}).promptConfigs;
const promptTaskKeys = promptDomain && typeof promptDomain === 'object' ? Object.keys(promptDomain) : [];
const promptChoiceModules = Array.isArray(promptDomain?.choice?.modules) ? promptDomain.choice.modules.length : -1;
const personaKeyOk = ['persona_curator', 'persona_gen'].every(k => Array.isArray(promptDomain?.[k]?.modules) && promptDomain[k].modules.length > 0);
const summaryKeyOk = ['summary_small', 'summary_big'].every(k => Array.isArray(promptDomain?.[k]?.modules) && promptDomain[k].modules.length > 0 && promptDomain[k].modules.some(m => m?.source === 'summary_source'));
if (promptTaskKeys.length !== 5 || promptChoiceModules !== 18 || !personaKeyOk || !summaryKeyOk) {
    failures.push(`默认提示词配置未正确初始化（期望 Record 五任务键、choice 18 模块；实际键 ${promptTaskKeys.join(',') || '无'}、choice 模块数 ${promptChoiceModules}）`);
}

// ---------------------------------------------------------------------------
// persona 机判：迁移/纯函数/api 形状/互斥（[persona-smoke] 行收口）
// ---------------------------------------------------------------------------
// PASS 行数精确断言（同 CHOICE_PASS_EXPECTED 纪律：丢断言必须红）。
// 期望构成＝迁移 14（空启动/3 键搬入/localConfig 退役快照保留/形状/退休键/
// legacy 快照/二次零重写/域在场仍清/域形状收缩/存量域退役字段丢弃含旧
// endpointId＋localConfig 旧键，收编 4 条：统一表形状/去重＋id 重映射/
// choice 域 v2 重写＋全局活动键提升/persona 域 v2 清洗）＋端点删除联动清空
// 1＋prompts 5（全任务键齐备含 choice 18 模块红线/旧数组一次写迁移/旧默认快照
// 版本化重建按 module id 在场且不多余/curator 与 persona_gen 两任务默认占位符）
// ＋persona 组装
// 7（curator 管线/persona_gen 管线占位符全填＋档案段正文零跨段引用「原则 N·要求
// N·策展段」三类标记全扫/档案段正文「块名·叶名」全落目录真实键/叶边界段随本次
// schema 收敛且行集＝字面量四行/叶边界段整段逐字节＝收敛成文/模块开关闭环）＋persona dump 观测口 2＋纯函数 12＋api 16（含 finish_reason=length 截断
// 显式报错回归＋破限预设解析 2：角色保真/marker·停用剔除、悬空名 null，
// ＋stub 同构机判 2：同一实例双方法 this 内部互调、保留接收者按名取预设）＋
// e2e 7（含取消通道 1：请求已发出后取消归类＋复位不误写；破限注入 2：两段
// 前缀在场＋悬空 fail-soft 不注入）＋store 7＋会话感知 3
// （CHAT_CHANGED 重置开场白默认档＋emit 接线全链＋无开场白卡回落不注入）＋
// host 活取用回归 2（this_chid 跟随＋chat_metadata 换引用写读落当前对象）＋
// 空白正文 fail fast 1（纯空白抛「API 返回为空」：错误 toast 在场＋结果框
// 保持原值＋互斥态干净）＋宿主错误信封 9（骨架判据 5：放行真骨架/拦下错误
// 正文/拦下空与散文/拦下散言前导换皮形态/拦下与切块口径分歧的 1 空格散言行；
// 传输层信封 3：流式抛错＋runlog 记失败/非流式抛错/正常产出以标签开头不误杀；
// 端到端 1：curator 段遇信封即中断、第二段不发出）＋策展目录与提示词正文 14
// （骨架逐块叶集合＝字面量期望、渲染行数＝目录条目数、L0 目录叶集与策展目录逐叶
// 相等（含块序与块内叶序）、叶总数＝196 绝对量、L0 旧叶名逐个不在目录里、
// L0 归属优先级对 10 对逐对相等且两端落在真实叶、条件叶成文在叶名串之后叶数段
// 之前·叶数段字面量、目录 definition 非空率 100%、countText 覆盖词面只配模板叶块、
// L0 策展清单渲染文本整段逐字节相等、策展/档案两段正文锁死（原则 7 逐叶裁叶＋
// 档案段原口径绝不留空；档案段零跨段引用改由组装段那条三类标记全扫判）、行为心理类块名串＝字面量九块、机制挂载开放段在场、新口径上限 16＋元层剥离、
// gen 值厚度与行为心理类传导；默认快照重建断言按 module id 存在性并上条数不多余）
// ＋档案段生成契约 11（要求 7 事实唯一归属：归属顺序 ①–⑦ 按序＋关键条款与末句
// 三维度例外；每个「→」归属处落在真实块名或「块名·叶名」；规则 4 跨叶不复述
// 半句追加在跨叶互补之后；三组反例五栏同构——重复写法/为什么不合格/重写的版本
// 各三处＋改法 2 处＋为什么合格 1 处；归属优先级表整段逐字节＝catalog 渲染；
// 叶边界段在模板里是宏位（段体逐字节＝{{catalog_definitions}}）且段头首行逐字
// ＝逐字档 C-1b、无位置指代；静态成文一叶一行且行数＝197（声明叶 196＋条件叶
// 1）；排除半句里的跨叶互指全落在目录真实键上（块·叶／裸叶名／裸块名·散文尾
// 豁免）；无「不装」半句的叶 0 兜底句零处——行数与兜底数互为交叉校验）
// ＋流内上游
// 错误帧 4＋
// 端点 prefill 能力记忆 4＋人设写回渲染通道 4（建档 initPersona 恰一次＋
// personas/描述符双写落地、两分支各刷一次列表、覆盖选中人设刷描述框＋
// 镜像同步、覆盖非选中人设走 setUserAvatar 静默切换且不碰描述框/镜像）
// ＋目录键集 1（条件叶按裸键名入集、模板叶块给「块名·」前缀哨兵：任一处退回
// `'name' in leaf` 或自剥方括号即翻红）＋档案叶级解析 11（叶层缩进取块内首叶：混合
// 缩进时拿上一个叶当基准会把末叶吞进中叶；列表承载叶与空值叶先排除：不排除即
// 4 叶两两互判 6 对假命中；块首行内联的首叶不丢：档案段 prefill 从冒号之后接写，
// 首叶不在缩进行上；1 空格缩进的叶仍算叶＋反向用例：切块口径缩进 ≤1 算块界，该文本
// 走切块两块皆空即零叶而报告与「无重复」不可区分；单块档案按分类码 SINGLE_BLOCK
// 拒判＋反向用例：单顶层键整块去缩进分支会丢顶层键；机制挂载块的原生叫法不再整行
// 丢弃且未识别块与未识别叶分开计；裸列表项与无主续行进无主行、不再静默丢弃；宿主
// 错误正文报 NO_LEAVES：它有 2 个顶层「块」，只靠块数放行等于没校验；错误正文凑够
// 两个顶层块时形状闸放行、判据层按目录外叶过半降级为 MOSTLY_OUT_OF_CATALOG；填好的
// 档案形状放行）＋确定性重复判据 8（契约点名的偷懒占位不算同值；LITERAL_SAMPLE 必
// 命中含靠标点表才成立的一对、反转版零命中、REDUNDANCY_SAMPLE 的 structural 报出归属
// 对第 2 对、该样本 literal 零命中是预期而非漏报、未识别块叶 0 在内联目录与默认目录
// 下各跑一次、归一两段分工机判、标点表里每个字符各一条只有它能成立的断言）
// ＋复核回合 10（判据层零命中仍无条件发出第三段·末段按指令首行认得出是复核段；
// 指令并进 messages 并携带整份档案＋末条是 user 的查重指令且整份请求里没有任何
// assistant 模型轮——复核轮不带起手词（读实发 body，不读传入的那份 messages）；
// 复核轮 400 不触发去起手词重试（三段共 3 次请求）·失败落降级态并保留首轮档案——
// 「不带起手词是本轮的决定」与「端点不支持起手词」两条路径不混；模型给的
// 「块.叶 → 值」逐叶直改·断言改后叶值本身而非「报出命中」·未点名叶逐字不动；
// 「保留」行逐字不动·计数与叶名清单不含保留叶；响应为空降级·结果框仍是首轮
// 内容·不弹错误；store 路径的结果框是复核后的那一份而非改写前的首轮档案；
// 复核轮收尾抛错（非 400 族）只降级不外抛·结果框仍首轮内容·不弹错误·真因带栈进
// 运行日志——降级保证是结构性的不挑失败形态；回复不可用一律回滚·点名不存在的叶
// 与写出新的完全同值两例；四态文案逐字＋失败原因白名单恰三项＋空结果框显未运行态）
// ＋目录漂移告警 3（判据层一条：catalogDriftLeaves 只装「目录内块里写出的
// 目录外叶」，机制挂载块的叶与无主行都不进；接线侧两条：warn 打在复核轮
// 收尾——模型回「无重复」那条最常见的路也打，载荷只有计数与符号名不带档案
// 内文；零计数时一条 warn 都不打）。
const PERSONA_PASS_EXPECTED = 152;
const personaPassLines = boot1Lines.filter(l => l.startsWith('[persona-smoke] PASS'));
const personaFailLines = boot1Lines.filter(MODULE_FAIL_LINE('persona'));
if (personaPassLines.length !== PERSONA_PASS_EXPECTED || personaFailLines.length > 0) {
    failures.push(`persona 机判异常：期望恰好 ${PERSONA_PASS_EXPECTED} 条 PASS，实际 ${personaPassLines.length} 条 / FAIL ${personaFailLines.length} 条${personaFailLines.length ? `（首条：${personaFailLines[0]}）` : ''}`);
}

// ---------------------------------------------------------------------------
// 目录派生段只有一份（标签符号计数）：叶边界段与归属优先级表各由 catalog 的
// 渲染函数成文一次，而两条逐字节锁都只在 OPEN 标签到 CLOSE 标签的切片里比
// ——模板正文别处再手抄一整段进去，两条锁一声不吭，出去的档案段里同一个边界
// 列表出现两遍且能各自漂。判据＝符号在 defaults.ts 正文（去掉 import 块，
// 数的是「用了几处」而不是「声明＋用了」）里的出现次数：两个标签各恰好一处，
// CATALOG_DEFINITIONS_HEADER 零处（段头只活在 catalog 的渲染函数里，它在模板
// 源码里出现即说明有人把段头抄进去了）。
// ---------------------------------------------------------------------------
const defaultsBody = readFileSync(new URL('../src/prompts/defaults.ts', import.meta.url), 'utf8')
    .replace(/import\s*\{[^}]*\}\s*from\s*'\.\/catalog';/, '');
const SEGMENT_SYMBOL_MAX = [
    ['CATALOG_DEFINITIONS_OPEN_TAG', 1],
    ['OWNERSHIP_TABLE_OPEN_TAG', 1],
    ['CATALOG_DEFINITIONS_HEADER', 0],
];
const overusedSymbols = SEGMENT_SYMBOL_MAX.filter(([symbol, max]) => (defaultsBody.split(symbol).length - 1) > max);
if (overusedSymbols.length > 0) {
    failures.push(`目录派生段只有一份：defaults.ts 里 ${overusedSymbols.map(([s, m]) => `${s} 出现 ${defaultsBody.split(s).length - 1} 次（上限 ${m}）`).join('、')}——同段被手抄了第二份`);
}

// ---------------------------------------------------------------------------
// summary 机判：触发算术/状态机/槽组合/守卫链/端到端（[summary-smoke] 行收口）
// ---------------------------------------------------------------------------
// PASS 行数精确断言（同 CHOICE_PASS_EXPECTED 纪律：丢断言必须红）。
// 期望构成＝触发算术 4（autoTriggerDue 判据回归、手动门槛、级联条件、
// roundsToTrigger 同源）＋槽组合 4（空/只大/只小/双节逐字）＋状态机 8
// （raw 含 floor 0/hide 双写＋批量落盘/退出 raw/翻回 is_system 不当
// raw/selfHeal 重隐藏＋落盘/幂等复跑/restoreAllFloors/一键还原三面）
// ＋normalize 4（下界钳/上界钳/缺省回默认＋退役字段丢弃/聊天态坏档剔除）
// ＋守卫与端到端 22（busy/取消零改动/autoEnabled/算术不达标/端点缺席/
// 无可总结/无可合并/空白输出 fail、e2e 完整链 7（落地/槽重挂/saveChat
// 通道/请求形状/组装 speaker/runlog task/落账后取消不回滚）、
// 级联 5（不满不触发/满触发替换清空/大总结源文本节/槽单节形态/手动同判）、
// think 剥离 1、源文本纯函数 1）＋事件接线 8（未开自动不触发/分组
// chat_id 不当楼层/算术不达标不触发/CHAT_CHANGED 自愈重隐藏＋重挂槽/
// 错误正文楼层到达时触发被拦下/批次内错误正文楼不进摘要源文本/达标
// 场景启动后台生成/完成后互斥归位＋折叠落账＋running 镜像清位）＝ 50。
const SUMMARY_PASS_EXPECTED = 50;
const summaryPassLines = boot1Lines.filter(l => l.startsWith('[summary-smoke] PASS'));
const summaryFailLines = boot1Lines.filter(MODULE_FAIL_LINE('summary'));
if (summaryPassLines.length !== SUMMARY_PASS_EXPECTED || summaryFailLines.length > 0) {
    failures.push(`summary 机判异常：期望恰好 ${SUMMARY_PASS_EXPECTED} 条 PASS，实际 ${summaryPassLines.length} 条 / FAIL ${summaryFailLines.length} 条${summaryFailLines.length ? `（首条：${summaryFailLines[0]}）` : ''}`);
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
const wipePassLines = boot1Lines.filter(l => l.startsWith('[wipe-smoke] PASS'));
const wipeFailLines = boot1Lines.filter(MODULE_FAIL_LINE('wipe'));
if (wipePassLines.length !== WIPE_PASS_EXPECTED_RUN1 || wipeFailLines.length > 0) {
    failures.push(`wipe 机判异常：期望恰好 ${WIPE_PASS_EXPECTED_RUN1} 条 PASS，实际 ${wipePassLines.length} 条 / FAIL ${wipeFailLines.length} 条${wipeFailLines.length ? `（首条：${wipeFailLines[0]}）` : ''}`);
}
// boot 位清理确实执行（非跳过）：首个 [legacy-wipe] 行＝删除 5/5 键
const firstWipeLog = boot1Lines.find(l => l.startsWith('[legacy-wipe]'));
if (!firstWipeLog || !firstWipeLog.includes('删除 5/5')) {
    failures.push(`boot 位一次性清理未执行或删键数异常（首行：${firstWipeLog ?? '无'}）`);
}

// ---------------------------------------------------------------------------
// apis 机判：批量设置行写通道（[apis-smoke] 行收口，runNodeSmoke 末位——
// 见 src/main.ts runNodeSmoke 接线）
// ---------------------------------------------------------------------------
// PASS 行数精确断言（同上纪律）＝ v1.12.0 批量设置行新增 5（批量写五行
// 齐换/调参档保留/出站路由跟随/store 写穿 revision/删服务商联动收尾）。
// ＋ v1.18.0 端点 prefill 能力记忆新增 4（noPrefill 归一兼容/路由带出
// providerId 与 noPrefill/记忆复位写穿＋revision 精确自增/悬空与重复写入静默）。
const APIS_PASS_EXPECTED = 9;
const apisPassLines = boot1Lines.filter(l => l.startsWith('[apis-smoke] PASS'));
const apisFailLines = boot1Lines.filter(MODULE_FAIL_LINE('apis'));
if (apisPassLines.length !== APIS_PASS_EXPECTED || apisFailLines.length > 0) {
    failures.push(`apis 机判异常：期望恰好 ${APIS_PASS_EXPECTED} 条 PASS，实际 ${apisPassLines.length} 条 / FAIL ${apisFailLines.length} 条${apisFailLines.length ? `（首条：${apisFailLines[0]}）` : ''}`);
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
// 行段两端都是 boot 收尾标记：起点在 boot1 断言全部跑完之后——boot2 与
// 未收尾的 boot1 并发跑会共用同一份宿主存根（宿主 context 是可换装单例，
// boot1 在途的 persona 段会覆写 boot2 的 chat 楼层），终点取 boot2 自己的
// 标记，免得 boot1 的尾巴混进本段计数。
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
const boot2End = await waitForBootDone(segmentStart, 'boot2');
const seg2 = outputLines.slice(segmentStart, boot2End);
const seg2FailTags = ['choice', 'persona', 'summary', 'wipe', 'apis']
    .filter(tag => seg2.filter(MODULE_FAIL_LINE(tag)).length > 0);
if (seg2FailTags.length > 0) {
    failures.push(`boot2：模块机判出现 FAIL（${seg2FailTags.map(tag => `${tag} ${seg2.filter(MODULE_FAIL_LINE(tag)).length} 条`).join('、')}）`);
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
const seg2SummaryPass = seg2.filter(l => l.startsWith('[summary-smoke] PASS')).length;
const seg2ApisPass = seg2.filter(l => l.startsWith('[apis-smoke] PASS')).length;
if (seg2ChoicePass !== CHOICE_PASS_EXPECTED || seg2PersonaPass !== PERSONA_PASS_EXPECTED || seg2SummaryPass !== SUMMARY_PASS_EXPECTED || seg2ApisPass !== APIS_PASS_EXPECTED) {
    failures.push(`boot2 冒烟重跑计数异常：choice ${seg2ChoicePass}/${CHOICE_PASS_EXPECTED}、persona ${seg2PersonaPass}/${PERSONA_PASS_EXPECTED}、summary ${seg2SummaryPass}/${SUMMARY_PASS_EXPECTED}、apis ${seg2ApisPass}/${APIS_PASS_EXPECTED}`);
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

console.log(`[smoke] OK：dist 加载成功，roundtrip ${roundtripLines.length} 条全 PASS，探测清单已打印，nav dump 口在场，P1 回归（存量 nav 域退役字段丢弃）与 chat 域立即保存链路均通过；choice 机判 ${choicePassLines.length} 条全 PASS（组装注入/解析回退＋池抽取分布/池注入/自动生成守卫链——单层池结构，条目自身 pinned 为真值），__TT_TOOLKIT__.prompts 全局口在场（dump 按任务，默认模板五任务键齐备）；persona 机判 ${personaPassLines.length} 条全 PASS（迁移收编幂等/域形状收缩与 v1.1.0 存量域退役字段丢弃/全任务键/统一端点请求形状与 SSE/三段链端到端与复核回合＋目录漂移告警/生成可停止/破限注入前缀/store 互斥与显式保存点/CHAT_CHANGED 会话感知清空/档案段生成契约：归属顺序＋三组反例五栏＋叶边界段宏位与静态 197 行＋跨叶互指落真键/组装段：档案段零跨段引用＋「块名·叶名」全落真键＋叶边界段按本次 schema 收敛）；summary 机判 ${summaryPassLines.length} 条全 PASS（触发算术 autoTriggerDue 判据回归/normalize 钳制含退役字段丢弃/槽组合四形态逐字/状态机 hide-restore-selfHeal/守卫链与取消边界/大总结级联/端到端请求形状/思维链剥离与错误楼拦截/事件接线守卫分支）；wipe 机判 ${wipePassLines.length} 条全 PASS（boot 删 5 键＋标记置位＋迁移数据存活证明/域零触碰/标记短路）；apis 机判 ${apisPassLines.length} 条全 PASS（任务档案批量写四行齐换/调参档保留/出站路由跟随/store 写穿 revision/夹具联动收尾）；boot2 二次启动 no-op 通过（清理短路＋冒烟重跑 choice ${seg2ChoicePass}/persona ${seg2PersonaPass}/summary ${seg2SummaryPass}/apis ${seg2ApisPass} 全 PASS）；退休符号 generateRaw dist 计数 0（apiSource/apiProfiles 由域结构断言保证退休）。`);
