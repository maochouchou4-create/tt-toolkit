/**
 * 触发算术（纯函数：node 冒烟直测；UI 状态行与自动触发守卫同源，
 * 禁在别处另写算式）。
 *
 * 口径声明（拍板）：interval/keep 以 2×N 楼近似 N 轮；quiet 楼层不滤、
 * 群聊多楼下每轮可多于 2 楼，实际是下界近似——批大小＝触发时全部
 * aged 楼层，可超过 interval 轮。UI「再聊 x 轮」的估算同源偏差，不
 * 做精确轮换算。
 *
 * 触发模式两相：fixed＝攒满即总结（现行语义，行为保真由映射断言锁死）；
 * adaptive＝三段式（最少间隔内 wait → 区间内问模型 judge → 强制线外
 * force）。判断的询问节奏（lastAskedAged）是会话内状态、归 auto.ts
 * 持有——本模块只收参数做纯判定，不落任何状态。
 */

/** 单次小总结批的楼层上限：防长聊天首启一次性吞数百楼 token 爆炸——超出部分留在 aged 池，下次触发继续吃。 */
export const MAX_FLOORS_PER_RUN = 30;

export interface TriggerPlan {
    /** 向下取偶后的 aged 楼层数（批界切在问-答轮界，不劈半轮） */
    eatCount: number;
    /** 本次应折叠的楼层数（0＝不触发；触发时＝min(eatCount, MAX_FLOORS_PER_RUN)） */
    batchSize: number;
}

/** 自动触发相位（adaptive 三段式；fixed 只出现 wait/force）。 */
export type AutoPhase =
    | { phase: 'wait' }
    /** askNow＝距上次询问已隔 judgeEvery 轮（从未询问过＝真） */
    | { phase: 'judge'; askNow: boolean }
    | { phase: 'force' };

/** aged 楼层数：raw 总数扣掉原文保留窗口，余数向下取偶（半轮不进批）。 */
export function agedFloorCount(rawCount: number, keepRounds: number): number {
    const aged = rawCount - keepRounds * 2;
    if (aged <= 0) return 0;
    return aged - (aged % 2);
}

/** aged 轮数（状态行展示口径；半轮向下取整）。 */
export function agedRoundCount(rawCount: number, keepRounds: number): number {
    return Math.floor(agedFloorCount(rawCount, keepRounds) / 2);
}

/**
 * 自动触发相位判定：fixed＝现行语义（aged ≥ interval×2 映射 force，
 * 否则 wait——行为保真回归断言锁死）；adaptive 按最少间隔／强制线
 * 分段，区间内按 lastAskedAged 判是否到询问点。
 */
export function planAutoPhase(rawCount: number, settings: { intervalRounds: number; keepRounds: number; triggerMode: 'fixed' | 'adaptive'; maxIntervalRounds: number; judgeEveryRounds: number }, lastAskedAged: number | null): AutoPhase {
    const aged = agedFloorCount(rawCount, settings.keepRounds);
    if (settings.triggerMode === 'fixed') {
        return aged >= settings.intervalRounds * 2 ? { phase: 'force' } : { phase: 'wait' };
    }
    if (aged >= settings.maxIntervalRounds * 2) return { phase: 'force' };
    if (aged < settings.intervalRounds * 2) return { phase: 'wait' };
    const askNow = lastAskedAged === null || aged - lastAskedAged >= settings.judgeEveryRounds * 2;
    return { phase: 'judge', askNow };
}

/** 触发后的批界算术（手动小总结与相位达标的自动运行共用：aged ≥ 2 即成批）。 */
export function planManualSmallSummary(rawCount: number, keepRounds: number): TriggerPlan {
    const eatCount = agedFloorCount(rawCount, keepRounds);
    return { eatCount, batchSize: eatCount >= 2 ? Math.min(eatCount, MAX_FLOORS_PER_RUN) : 0 };
}

/** 大总结级联条件：小总结成功落账后未折叠群攒满 bigEvery 条即触发（自动级联与手动同判）。 */
export function shouldRunBigSummary(smallCount: number, bigEvery: number): boolean {
    return smallCount >= bigEvery;
}

/** UI 状态行「再聊 x 轮触发小总结」（fixed 模式）：与自动触发守卫同源的缺口换算（0＝已达标）。 */
export function roundsToTrigger(rawCount: number, intervalRounds: number, keepRounds: number): number {
    const deficit = intervalRounds * 2 - agedFloorCount(rawCount, keepRounds);
    return deficit <= 0 ? 0 : Math.ceil(deficit / 2);
}
