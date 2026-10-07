/**
 * 楼层折叠状态机的楼层侧原语：flag 操作／自愈／派生。
 *
 * 单一事实源纪律：被隐藏楼层的标记在各楼 message.extra.ttToolkit.summaryHidden
 * （boolean 纯数据，structuredClone 安全），is_system 是该 flag 的应用
 * 效果（自愈可重放）；hiddenCount 一律派生，不落第二份计数。本模块只
 * 动楼层与派生，不碰 chat 域（总结态读写归 settings.ts，编排归 generator）。
 */

import { EXTRA_NAMESPACE_KEY, getChatMessages, saveCurrentChat, type ChatMessage } from '@/host';

/** 该楼层是否带总结隐藏标记（flag 判据单点）。 */
export function isSummaryHiddenFloor(message: ChatMessage): boolean {
    const extra = message.extra as { [EXTRA_NAMESPACE_KEY]?: { summaryHidden?: unknown } } | undefined;
    return extra?.[EXTRA_NAMESPACE_KEY]?.summaryHidden === true;
}

/**
 * raw 楼层判据（双条件 belt-and-braces）：is_system 与 flag 任一为真都
 * 不算 raw——自愈间隙里被手动翻回 is_system 的 flag 楼层不当 raw，防
 * 同一楼层被重复总结。
 */
export function isRawFloor(message: ChatMessage): boolean {
    return message.is_system !== true && !isSummaryHiddenFloor(message);
}

/** 全部 raw 楼层的绝对索引（按楼层序）。 */
export function rawFloorIndices(): number[] {
    const out: number[] = [];
    const chat = getChatMessages();
    for (let i = 0; i < chat.length; i++) {
        if (isRawFloor(chat[i])) out.push(i);
    }
    return out;
}

/** 派生 hiddenCount（不落盘的单一算法）。 */
export function hiddenFloorCount(): number {
    return getChatMessages().filter(isSummaryHiddenFloor).length;
}

/** extra 命名空间容器（缺则补建；容器对象为纯数据）。 */
function ensureExtraNamespace(message: ChatMessage): Record<string, unknown> {
    const extra = (message.extra && typeof message.extra === 'object' ? message.extra : {}) as Record<string, unknown>;
    message.extra = extra;
    const ns = (extra[EXTRA_NAMESPACE_KEY] && typeof extra[EXTRA_NAMESPACE_KEY] === 'object' ? extra[EXTRA_NAMESPACE_KEY] : {}) as Record<string, unknown>;
    extra[EXTRA_NAMESPACE_KEY] = ns;
    return ns;
}

/**
 * 隐藏目标楼层（is_system=true＋flag）并立即落盘（一次 saveCurrentChat
 * 批量收口——逐楼保存会把同一批折叠拆成 N 次落盘）。返回实际隐藏数。
 */
export function hideFloors(indices: number[]): number {
    const chat = getChatMessages();
    let hidden = 0;
    for (const idx of indices) {
        const message = chat[idx];
        if (!message) continue;
        message.is_system = true;
        ensureExtraNamespace(message).summaryHidden = true;
        hidden++;
    }
    if (hidden > 0) saveCurrentChat();
    return hidden;
}

/**
 * 还原全部 flag 楼层（is_system=false＋删 flag）并立即落盘。返回还原
 * 数；chat 域总结态清空与槽清理由调用方编排（本函数只动楼层）。
 */
export function restoreAllFloors(): number {
    const chat = getChatMessages();
    let restored = 0;
    for (const message of chat) {
        if (!isSummaryHiddenFloor(message)) continue;
        message.is_system = false;
        const extra = message.extra as { [k: string]: Record<string, unknown> | undefined } | undefined;
        if (extra?.[EXTRA_NAMESPACE_KEY]) delete extra[EXTRA_NAMESPACE_KEY].summaryHidden;
        restored++;
    }
    if (restored > 0) saveCurrentChat();
    return restored;
}

/**
 * 自愈（CHAT_CHANGED／加载时调）：flag 且 !is_system 的楼层重新隐藏
 * （flag 是单一事实源，is_system 是可重放的应用效果——外部改动/异常
 * 只丢效果不丢标记）。有变化才落盘。
 */
export function selfHealSummaryState(): { rehidden: number } {
    const chat = getChatMessages();
    let rehidden = 0;
    for (const message of chat) {
        if (isSummaryHiddenFloor(message) && message.is_system !== true) {
            message.is_system = true;
            rehidden++;
        }
    }
    if (rehidden > 0) saveCurrentChat();
    return { rehidden };
}
