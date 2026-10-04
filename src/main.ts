/**
 * 扩展引导：host 适配初始化 → storage 初始化 → 壳挂载 → nav 注册。
 *
 * 双路径：
 *   - 浏览器（TT 宿主窗口）：完整初始化；
 *   - node 冒烟（无 DOM，scripts/smoke.mjs 驱动）：跳过 DOM 侧接线，
 *     输出 host 探测清单 + storage roundtrip（批A 判据的机判部分）。
 *     node 下 @sillytavern 外置导入由冒烟脚本的 loader 存根承载，
 *     真实宿主在场性归浏览器验收。
 */

// 先激活 pinia：后续命令式模块在事件回调里取 store 依赖 active 实例
import '@/pinia';
import { formatProbeResults, probeHost } from '@/host';
import { mountShell, registerTab } from '@/shell';
import { createDebugTab, createNavSettingsTab } from '@/shell/tabs';
import { dumpStorage, initStorage, runStorageRoundtrip } from '@/storage';
import '@/modules/nav';
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
    const nav = (globalThis as { __TT_NAV__?: { version?: string; dump?: () => string } }).__TT_NAV__;
    if (nav) {
        console.info(`=== nav dump（${nav.version ?? '?'}）===`);
        console.info(typeof nav.dump === 'function' ? nav.dump() : '（dump 不可用）');
    } else {
        console.warn('=== nav 模块未初始化（__TT_NAV__ 不在场）===');
    }
}

async function main(): Promise<void> {
    if (typeof document === 'undefined') {
        await runNodeSmoke();
        return;
    }
    initStorage();
    mountShell();
    registerTab(createDebugTab());
    registerTab(createNavSettingsTab());
    console.info(`[tt-toolkit] v${version} ready (rewrite)`);
}

void main();
