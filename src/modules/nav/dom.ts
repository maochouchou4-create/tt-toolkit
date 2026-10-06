/**
 * nav DOM 定位与楼层数据接口：主窗口本体运行，无跨窗口，直接 document。
 * 楼层号即 chat[] 绝对索引（全量数组，无窗口化），不猜 DOM；统一走
 * host 层（getChatMessages）。
 */

import { getChatMessages, type ChatMessage } from '@/host';
import { CONFIG } from './config';

export function getScrollRoot(): HTMLElement | null {
    return document.querySelector(CONFIG.SEL.SCROLL_ROOT);
}

export function findMessageEl(messageId: number): HTMLElement | null {
    return document.querySelector(`${CONFIG.SEL.MESSAGE}[mesid="${messageId}"]`);
}

export function getChat(): ChatMessage[] {
    return getChatMessages();
}

// 消息角色判定（ChatPayload 契约）：正常楼层只保证 legacy 布尔
// is_user/is_system；role 并不总存在（Tool 明确 role:"tool" 且
// is_system:true）。role 缺失时按布尔回退：非用户、非系统＝Assistant。
function messageRole(m: ChatMessage): string {
    if (typeof m?.role === 'string' && m.role) return m.role;
    if (m?.is_user) return 'user';
    if (m?.is_system) return 'system';
    return 'assistant';
}

export function getAssistantFloorIds(): number[] {
    return getChat()
        .map((m, i) => (messageRole(m) === 'assistant' ? i : Number.NaN))
        .filter(Number.isFinite);
}

export function getLastMessageIdSafe(): number | null {
    const chat = getChat();
    return chat.length > 0 ? chat.length - 1 : null;
}

// 视口顶部当前正看到的楼层（只在已挂载的楼层里找 —— 可见的必然已挂载）
export function getCurrentVisibleMessageId(): number | null {
    const root = getScrollRoot();
    if (!root) return null;
    const rootTop = root.getBoundingClientRect().top;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CONFIG.SEL.MESSAGE))) {
        const bottom = el.getBoundingClientRect().bottom;
        if (bottom < rootTop + CONFIG.VISIBLE_THRESHOLD_PX) continue; // 整体在视口顶之上
        const id = Number(el.getAttribute('mesid'));
        return Number.isFinite(id) ? id : null; // DOM 顺序即楼层升序，第一个跨过视口顶的就是它
    }
    return null;
}
