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
import { existsSync } from 'node:fs';

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
const noop = () => {};

globalThis.__TT_SMOKE_STUBS__ = {
    // settings 可变单例（roundtrip 载体）
    extension_settings: {},
    chat_metadata: {},
    characters: [],
    this_chid: '0',
    // 全局 settings 防抖落盘（node 下 noop；roundtrip 只测内存写读链路）
    saveSettingsDebounced: noop,
    // 事件总线（真实 API 面无 off，摘除监听为 removeListener）
    eventSource: { on: noop, once: noop, emit: noop },
    event_types: {
        APP_READY: 'app_ready',
        CHAT_CHANGED: 'chat_id_changed',
        MESSAGE_UPDATED: 'message_updated',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        SETTINGS_LOADED: 'settings_loaded',
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
    getContext: () => ({
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
    }),
    saveMetadataCalls: 0,
};

// ---------------------------------------------------------------------------
// 驱动 dist：main.ts 检测无 document 走冒烟分支并打印全部输出。
// 收集 stdout 行做机判断言（roundtrip PASS、nav __TT_NAV__ 在场）。
// ---------------------------------------------------------------------------
const outputLines = [];
const origLog = console.log;
const origInfo = console.info;
const tap = (prefix) => (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    outputLines.push(line);
    if (prefix === 'log') origLog(line);
    else origInfo(line);
};
console.log = tap('log');
console.info = tap('info');

register('./stub-loader.mjs', import.meta.url);

try {
    await import(DIST_ENTRY);
} catch (e) {
    console.error('[smoke] dist/index.js 加载失败', e);
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

// chat 域写入走立即保存通道（writeChatMetadata → getContext().saveMetadata）
if (globalThis.__TT_SMOKE_STUBS__.saveMetadataCalls < 1) {
    failures.push('writeChatMetadata 未触发 getContext().saveMetadata（chat 域立即保存链路未接通）');
}

if (failures.length > 0) {
    for (const f of failures) console.error(`[smoke] FAIL: ${f}`);
    process.exit(1);
}

console.log(`[smoke] OK：dist 加载成功，roundtrip ${roundtripLines.length} 条全 PASS，探测清单已打印，nav dump 口在场，P1 时序回归（旧关态迁移）与 chat 域立即保存链路均通过。`);
