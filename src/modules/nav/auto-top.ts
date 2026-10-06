/**
 * nav 自动回顶：主触发 #mes_stop 可见→隐藏（整条生成管线空闲）；
 * 加固：静默窗口内 MESSAGE_UPDATED / 楼层重渲染会顺延计时。
 * 自动回顶恒开：用户开关已退役（v1.5.10），无需配置、不可关闭。
 */

import { CONFIG, ttlog } from './config';
import { getLastMessageIdSafe } from './dom';
import { jumpToFloor } from './scroll';

const autoTop = {
    settleTimer: null as ReturnType<typeof setTimeout> | null,
    settleFirstAt: 0,     // 本轮静默窗口的起点（用于 MAX_SETTLE_MS 兜底）
    lastGenerationActive: null as boolean | null,
    observer: null as MutationObserver | null,
};

// 生成是否进行中：主干用 $('#mes_stop').css('display') 切换（TT script.js:4448-4454）
export function isGenerationActive(): boolean {
    const stop = document.querySelector(CONFIG.SEL.STOP_BUTTON);
    if (!(stop instanceof HTMLElement)) return false;
    if (stop.style.display === 'none') return false;
    if (stop.classList.contains('displayNone')) return false;
    const display = stop.style.display || window.getComputedStyle(stop).display;
    return display !== 'none' && display !== '';
}

function clearSettleTimer(): void {
    if (autoTop.settleTimer !== null) {
        clearTimeout(autoTop.settleTimer);
        autoTop.settleTimer = null;
    }
}

function scheduleAutoTop(): void {
    const now = Date.now();
    if (autoTop.settleTimer === null) autoTop.settleFirstAt = now;
    clearSettleTimer();
    if (now - autoTop.settleFirstAt >= CONFIG.MAX_SETTLE_MS) {
        ttlog.action('settle max wait reached, auto-top now');
        void runAutoTop();
        return;
    }
    autoTop.settleTimer = setTimeout(() => {
        autoTop.settleTimer = null;
        void runAutoTop();
    }, CONFIG.SETTLE_MS);
}

// 生成结束后仍有渲染活动（MVU 改写/楼层重渲染）时顺延静默窗口
export function bumpSettle(): void {
    if (autoTop.settleTimer !== null) {
        scheduleAutoTop();
    }
}

async function runAutoTop(): Promise<void> {
    try {
        const targetId = getLastMessageIdSafe();
        if (targetId === null) {
            ttlog.warn('auto-top: no floor to jump');
            return;
        }
        const res = await jumpToFloor(targetId);
        if (res.ok) {
            ttlog.action(`auto-top -> #${targetId} (${res.mode})`);
        } else {
            ttlog.warn('auto-top failed');
        }
    } catch (e) {
        ttlog.error('auto-top error', e instanceof Error ? e.message : String(e));
    }
}

function checkGenerationIdle(): void {
    const active = isGenerationActive();
    const wasActive = autoTop.lastGenerationActive;
    autoTop.lastGenerationActive = active;
    if (wasActive && !active) {
        scheduleAutoTop();
    }
}

export function startGenerationWatch(): void {
    const Obs = window.MutationObserver;
    const stop = document.querySelector(CONFIG.SEL.STOP_BUTTON);
    const send = document.querySelector(CONFIG.SEL.SEND_BUTTON);
    if (!Obs || (!stop && !send)) {
        ttlog.warn('generation watch unavailable', { observer: !!Obs, stop: !!stop, send: !!send });
        return;
    }
    autoTop.lastGenerationActive = isGenerationActive();
    autoTop.observer = new Obs(() => {
        try {
            checkGenerationIdle();
        } catch (e) {
            ttlog.error('generation check error', e instanceof Error ? e.message : String(e));
        }
    });
    const options: MutationObserverInit = { attributes: true, attributeFilter: ['style', 'class'] };
    if (stop) autoTop.observer.observe(stop, options);
    if (send) autoTop.observer.observe(send, options);
    ttlog.info('generation watch started', { stop: !!stop, send: !!send });
}

/** 切换聊天时丢弃未完成的自动回顶（新聊天楼层状态未知）。 */
export function clearPendingAutoTop(): void {
    clearSettleTimer();
}
