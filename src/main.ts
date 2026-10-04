/**
 * 扩展引导：唯一环境分支点（批A 修复：模块不再自行探测环境自启动）。
 *
 * 浏览器（TT 宿主窗口）流：initStorage() → mountShell() → registerTabs
 * → initNav()。node 冒烟（无 DOM，scripts/smoke.mjs 驱动）流：
 * initStorage() → host 探测清单 + storage roundtrip → nav 最小初始化。
 * 时序约束：storage 必须先于一切读方初始化（旧 localStorage 键迁移
 * 先于 store 首读），故初始化主权集中在此、不在各模块。
 * node 下 @sillytavern 外置导入由冒烟脚本的 loader 存根承载，
 * 真实宿主在场性归浏览器验收。
 */

// 先激活 pinia：后续命令式模块在事件回调里取 store 依赖 active 实例
import '@/pinia';
import { formatProbeResults, probeHost } from '@/host';
import { mountShell, registerTab } from '@/shell';
import { createChoiceSettingsTab, createDebugTab, createNavSettingsTab, createPromptEditorTab } from '@/shell/tabs';
import { dumpStorage, initStorage, runStorageRoundtrip } from '@/storage';
import { initChoice, initChoiceMinimal, runChoiceSmoke } from '@/modules/choice';
import { initNav, initNavMinimal } from '@/modules/nav';
import { version } from '@/version';

async function runNodeSmoke(): Promise<void> {
    console.info(`[tt-toolkit] node 冒烟模式 v${version}（无 DOM；真实宿主在场性归浏览器验收）`);
    initStorage();
    console.info('=== host API 探测清单 ===');
    console.info(formatProbeResults(probeHost()));
    console.info('=== storage 写读 roundtrip ===');
    const reports = runStorageRoundtrip();
    for (const r of reports) {
        console.info(`[roundtrip:${r.scope}] ${r.ok ? 'PASS' : 'FAIL'} written=${r.written} readBack=${r.readBack} @ ${r.at}`);
    }
    console.info('=== storage 快照 ===');
    console.info(dumpStorage());
    initNavMinimal();
    const nav = (globalThis as { __TT_NAV__?: { version?: string; dump?: () => string } }).__TT_NAV__;
    if (nav) {
        console.info(`=== nav dump（${nav.version ?? '?'}）===`);
        console.info(typeof nav.dump === 'function' ? nav.dump() : '（dump 不可用）');
    } else {
        console.warn('=== nav 模块未初始化（__TT_NAV__ 不在场）===');
    }
    initChoiceMinimal();
    // 批B 机判：组装纯函数路径＋解析回退确定性触发（断言在 smoke.mjs 收口）
    await runChoiceSmoke();
}

async function main(): Promise<void> {
    if (typeof document === 'undefined') {
        await runNodeSmoke();
        return;
    }
    initStorage();
    mountShell();
    registerTab(createChoiceSettingsTab());
    registerTab(createPromptEditorTab());
    registerTab(createNavSettingsTab());
    registerTab(createDebugTab());
    initChoice();
    initNav();
    console.info(`[tt-toolkit] v${version} ready (rewrite)`);
}

void main();
