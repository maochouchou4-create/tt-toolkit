/**
 * nav 手动功能：回顶 / 上一条 / 下一条角色回复。
 * 导航参考楼层：/chat-jump 是居中落点，跳完视口顶不再是目标楼层，
 * 若每次都按视口顶算会跳乱/漏楼。记住上次导航目标；用户明显滚开
 * （视口顶远离记忆点）则按视口顶算。CHAT_CHANGED 时清空（index 接线）。
 */

import { showToast as toast } from '@/host';
import { CONFIG, ttlog } from './config';
import { getAssistantFloorIds, getCurrentVisibleMessageId, getLastMessageIdSafe, getChat } from './dom';
import { jumpToFloor } from './scroll';

let lastNavTarget: number | null = null;

function navReferenceId(currentId: number): number {
    if (lastNavTarget !== null && Math.abs(currentId - lastNavTarget) <= CONFIG.NAV_REF_TOLERANCE) {
        return lastNavTarget;
    }
    return currentId;
}

export async function scrollCurrentMessageToTop(): Promise<void> {
    const currentId = getCurrentVisibleMessageId();
    const targetId = currentId ?? getLastMessageIdSafe();
    if (targetId === null) {
        ttlog.warn('top: no floor found (viewport empty, chat empty)');
        toast('未找到当前消息', 'error');
        return;
    }
    const res = await jumpToFloor(targetId);
    if (!res.ok) ttlog.warn(`top failed -> #${targetId}`);
    else lastNavTarget = targetId;
    toast(res.ok ? `已定位楼层 #${targetId}` : '定位失败', res.ok ? 'success' : 'error');
}

export async function navigateAssistantReply(direction: -1 | 1): Promise<void> {
    const currentId = getCurrentVisibleMessageId();
    if (currentId === null) {
        ttlog.warn('nav: viewport floor not found');
        toast('未找到当前消息', 'error');
        return;
    }
    const ids = getAssistantFloorIds();
    if (ids.length === 0) {
        // 失败必须留痕（toast 完就 return、日志零痕迹无法排障的教训）
        ttlog.warn('nav: no assistant floor found', { chatLen: getChat().length, fromId: currentId });
        toast('没找到角色回复', 'warning');
        return;
    }
    const refId = navReferenceId(currentId);

    let target: number | null = null;
    if (direction < 0) {
        for (let i = ids.length - 1; i >= 0; i--) {
            if (ids[i] < refId) {
                target = ids[i];
                break;
            }
        }
        if (target === null) {
            ttlog.nav(`nav prev at first (ref #${refId}, ${ids.length} replies)`);
            toast('已经是第一条角色回复', 'info');
            return;
        }
    } else {
        for (const id of ids) {
            if (id > refId) {
                target = id;
                break;
            }
        }
        if (target === null) {
            ttlog.nav(`nav next at last (ref #${refId}, ${ids.length} replies)`);
            toast('已经是最后一条角色回复', 'info');
            return;
        }
    }

    const res = await jumpToFloor(target);
    if (res.ok) {
        lastNavTarget = target;
        toast(`${direction < 0 ? '已跳到上一条' : '已跳到下一条'}角色回复：#${target}`, 'success');
        ttlog.nav(`${direction < 0 ? 'prev' : 'next'} #${refId} -> #${target} (${res.mode})`);
    } else {
        ttlog.warn(`nav ${direction < 0 ? 'prev' : 'next'} -> #${target} failed`);
        toast('定位失败', 'error');
    }
}

/** 切换聊天时清空楼层记忆点（新聊天楼号重排）。 */
export function clearNavReference(): void {
    lastNavTarget = null;
}
