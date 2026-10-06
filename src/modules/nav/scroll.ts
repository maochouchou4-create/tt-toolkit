/**
 * nav 楼层定位核心：主线 /chat-jump 优先，脚本内滚动仅作兜底
 * （执行器来源＝host 层 executeSlashCommand：宿主 ABI 为唯一路径）。
 */

import { executeSlashCommand, getTavernContext } from '@/host';
import { CONFIG, sleep, ttlog } from './config';
import { findMessageEl, getScrollRoot } from './dom';

// 跳转通道运行时真值（dump 排障面）：执行器在场探测 + 每次实际跳转
// 记录的通道。回显 CONFIG 常量只证明「配置想用主线」，证明不了
// 「执行器在场 / 实际走了主线」——排障时两者要能区分。
let lastJumpMode: 'mainline' | 'fallback' | null = null;

export function jumpExecutorAvailable(): boolean {
    return typeof getTavernContext()?.executeSlashCommandsWithOptions === 'function';
}

export function lastJumpModeUsed(): 'mainline' | 'fallback' | null {
    return lastJumpMode;
}

// 主线跳转：/chat-jump → virtual.force + 同步物化 + scrollToIndex（居中 + 高亮闪烁）
// 返回 { ok, mode: 'mainline' | 'fallback' } 供日志标注跳转方式
export async function jumpToFloor(messageId: number): Promise<{ ok: boolean; mode: 'mainline' | 'fallback' }> {
    if (!Number.isFinite(messageId)) {
        ttlog.warn(`jumpToFloor: invalid floor ${messageId}`);
        return { ok: false, mode: 'fallback' };
    }
    if (CONFIG.MAINLINE_JUMP_FIRST) {
        try {
            await executeSlashCommand(`/chat-jump ${messageId}`);
            lastJumpMode = 'mainline';
            ttlog.action(`jump -> #${messageId} (mainline)`);
            return { ok: true, mode: 'mainline' };
        } catch (e) {
            ttlog.warn(`chat-jump -> #${messageId} failed, fallback scroll`, e instanceof Error ? e.message : String(e));
        }
    }
    lastJumpMode = 'fallback';
    const ok = await scrollToMessageTop(messageId, { smooth: false });
    return { ok, mode: 'fallback' };
}

// 兜底：脚本内“瞬时跳 + 落点校验”（目标未挂载先物化；落地后复核，偏差即修正）
export async function scrollToMessageTop(messageId: number, { smooth = true } = {}): Promise<boolean> {
    if (!Number.isFinite(messageId)) {
        ttlog.warn(`scrollToMessageTop: invalid floor ${messageId}`);
        return false;
    }
    const root = getScrollRoot();
    if (!root) {
        ttlog.error(`scroll root ${CONFIG.SEL.SCROLL_ROOT} not found`);
        return false;
    }

    const materialize = async () => {
        let el = findMessageEl(messageId);
        if (!el) {
            ttlog.info(`floor #${messageId} not mounted, materialize tail`);
            try {
                root.scrollTop = root.scrollHeight;
                await sleep(CONFIG.MATERIALIZE_WAIT_MS);
                el = findMessageEl(messageId);
            } catch (e) {
                ttlog.error('materialize scroll failed', e instanceof Error ? e.message : String(e));
            }
        }
        return el;
    };

    const el = await materialize();
    if (!el) {
        ttlog.warn(`floor #${messageId} not mounted, abort scroll`);
        return false;
    }

    try {
        const rootRect = root.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const target = Math.max(0, root.scrollTop + (elRect.top - rootRect.top) + CONFIG.SCROLL_OFFSET_PX);
        ttlog.action(`scroll -> #${messageId} (fallback)`, { from: Math.round(root.scrollTop), to: Math.round(target) });
        root.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });

        // 落点校验：虚拟列表滚动途中重挂载/重测量楼层，内容可能整体位移把落点带偏
        for (let attempt = 1; attempt <= CONFIG.SCROLL_VERIFY_TRIES; attempt++) {
            await sleep(attempt === 1 ? CONFIG.SCROLL_VERIFY_FIRST_DELAY_MS : CONFIG.SCROLL_VERIFY_DELAY_MS);
            let verifyEl = findMessageEl(messageId);
            if (!verifyEl) {
                root.scrollTop = root.scrollHeight;
                await sleep(CONFIG.MATERIALIZE_WAIT_MS);
                verifyEl = findMessageEl(messageId);
                if (!verifyEl) break;
            }
            const delta = verifyEl.getBoundingClientRect().top - root.getBoundingClientRect().top + CONFIG.SCROLL_OFFSET_PX;
            if (Math.abs(delta) <= CONFIG.SCROLL_VERIFY_TOLERANCE_PX) {
                if (attempt > 1) ttlog.action(`landing corrected -> #${messageId}`);
                return true;
            }
            ttlog.info(`landing correction #${attempt} -> #${messageId} delta=${Math.round(delta)}px`);
            root.scrollTo({ top: Math.max(0, root.scrollTop + delta), behavior: 'auto' });
        }
        ttlog.warn(`landing unstable after ${CONFIG.SCROLL_VERIFY_TRIES} tries -> #${messageId}`);
        return true;
    } catch (e) {
        ttlog.error(`scroll -> #${messageId} failed`, e instanceof Error ? e.message : String(e));
        return false;
    }
}
