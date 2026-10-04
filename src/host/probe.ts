/**
 * host API 探测清单（批A 判据的可视化/机判载体之一）。
 *
 * 每项探测＝「适配层依赖的一个宿主能力」，node 冒烟与浏览器调试 tab
 * 共用同一份清单逐项打印在场/缺席。node 冒烟下 DOM/运行时全局项按
 * 实际缺席打印（ESM 导入项除外——导入链由 stub 承载，详见
 * scripts/smoke.mjs 头注）；真实在场性归浏览器验收。
 */

import { getTavernContext } from './context';
import { hostWindow } from './dom';
import { isSlashCommandRegistered } from './slash';

export interface ProbeResult {
    name: string;
    present: boolean;
    detail: string;
}

function probe(name: string, check: () => { present: boolean; detail: string }): ProbeResult {
    try {
        const { present, detail } = check();
        return { name, present, detail };
    } catch (e) {
        return { name, present: false, detail: `探测异常：${e instanceof Error ? e.message : String(e)}` };
    }
}

function hasDocument(): boolean {
    return typeof document !== 'undefined';
}

/**
 * 探测全部宿主依赖并返回清单。浏览器与 node 冒烟共用。
 */
export function probeHost(): ProbeResult[] {
    return [
        probe('SillyTavern.getContext（globalThis 挂载）', () => {
            const fn = hostWindow.SillyTavern?.getContext;
            return { present: typeof fn === 'function', detail: typeof fn };
        }),
        probe('getContext() 可调用（st-context ESM 导入）', () => {
            const ctx = getTavernContext();
            return { present: ctx !== null, detail: ctx ? `chat=${ctx.chat?.length ?? 0} 条` : 'null' };
        }),
        probe('宿主 jQuery（全局 $，dragElement 依赖）', () => {
            return { present: typeof hostWindow.$ === 'function', detail: typeof hostWindow.$ };
        }),
        probe('#extensionsMenu（魔棒菜单 DOM）', () => {
            const present = hasDocument() && document.querySelector('#extensionsMenu') !== null;
            return { present, detail: present ? '在场' : '未挂载（等待宿主创建）' };
        }),
        probe('#floatingPrompt（drawer-content 浮层先例 DOM）', () => {
            const present = hasDocument() && document.querySelector('#floatingPrompt') !== null;
            return { present, detail: present ? '在场' : '未挂载' };
        }),
        probe('#movingDivs（浮层挂载容器 DOM）', () => {
            const present = hasDocument() && document.querySelector('#movingDivs') !== null;
            return { present, detail: present ? '在场' : '未挂载' };
        }),
        probe('#chat 滚动根（nav 楼层定位依赖）', () => {
            const present = hasDocument() && document.querySelector('#chat') !== null;
            return { present, detail: present ? '在场' : '未挂载' };
        }),
        probe('#send_form（选项条停靠容器）', () => {
            const present = hasDocument() && document.querySelector('#send_form') !== null;
            return { present, detail: present ? '在场' : '未挂载' };
        }),
        probe('SmartTheme CSS 变量（--SmartThemeBodyColor）', () => {
            if (!hasDocument()) return { present: false, detail: '无 DOM 环境' };
            const value = getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor').trim();
            return { present: value !== '', detail: value === '' ? '空值' : value };
        }),
        probe('quickReplyApi（全局 QR API）', () => {
            return { present: typeof hostWindow.quickReplyApi !== 'undefined', detail: typeof hostWindow.quickReplyApi };
        }),
        probe('toastr（全局提示）', () => {
            return { present: typeof hostWindow.toastr?.success === 'function', detail: typeof hostWindow.toastr };
        }),
        probe('Tauri invoke（ttlog 落盘通道）', () => {
            const w = globalThis as unknown as { __TAURI__?: { core?: { invoke?: unknown } }; __TAURITAVERN__?: { core?: { invoke?: unknown } } };
            const invoke = w.__TAURI__?.core?.invoke ?? w.__TAURITAVERN__?.core?.invoke;
            return { present: typeof invoke === 'function', detail: typeof invoke };
        }),
        probe('斜令 /ttnav-top 已注册', () => {
            return { present: isSlashCommandRegistered('ttnav-top'), detail: 'SlashCommandParser.commands' };
        }),
    ];
}

/** 探测清单渲染为逐行文本（冒烟输出/剪贴板格式）。 */
export function formatProbeResults(results: ProbeResult[]): string {
    return results
        .map(r => `[${r.present ? '在场' : '缺席'}] ${r.name} — ${r.detail}`)
        .join('\n');
}
