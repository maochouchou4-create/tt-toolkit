/**
 * 触发算术（纯函数：node 冒烟直测；UI 状态行与自动触发守卫同源，
 * 禁在别处另写算式）。
 *
 * 口径声明（拍板）：interval/keep 以 2×N 楼近似 N 轮；quiet 楼层不滤、
 * 群聊多楼下每轮可多于 2 楼，实际是下界近似——批大小＝触发时全部
 * aged 楼层，可超过 interval 轮。UI「再聊 x 轮」的估算同源偏差，不
 * 做精确轮换算。
 */

/** 单次小总结批的楼层上限：防长聊天首启一次性吞数百楼 token 爆炸——超出部分留在 aged 池，下次触发继续吃。 */
export const MAX_FLOORS_PER_RUN = 30;

export interface TriggerPlan {
    /** 向下取偶后的 aged 楼层数（批界切在问-答轮界，不劈半轮） */
    eatCount: number;
    /** 本次应折叠的楼层数（0＝不触发；触发时＝min(eatCount, MAX_FLOORS_PER_RUN)） */
    batchSize: number;
}

/** aged 楼层数：raw 总数扣掉原文保留窗口，余数向下取偶（半轮不进批）。 */
function agedFloorCount(rawCount: number, keepRounds: number): number {
    const aged = rawCount - keepRounds * 2;
    if (aged <= 0) return 0;
    return aged - (aged % 2);
}

/** 自动小总结触发算术：aged 攒满 interval 轮（2×interval 楼）才触发。 */
export function planAutoSmallSummary(rawCount: number, intervalRounds: number, keepRounds: number): TriggerPlan {
    const eatCount = agedFloorCount(rawCount, keepRounds);
    const eligible = eatCount >= intervalRounds * 2;
    return { eatCount, batchSize: eligible ? Math.min(eatCount, MAX_FLOORS_PER_RUN) : 0 };
}

/** 手动小总结触发算术：无间隔门槛，aged ≥ 2（一整轮）即可。 */
export function planManualSmallSummary(rawCount: number, keepRounds: number): TriggerPlan {
    const eatCount = agedFloorCount(rawCount, keepRounds);
    return { eatCount, batchSize: eatCount >= 2 ? Math.min(eatCount, MAX_FLOORS_PER_RUN) : 0 };
}

/** 大总结级联条件：小总结成功落账后未折叠群攒满 bigEvery 条即触发（自动级联与手动同判）。 */
export function shouldRunBigSummary(smallCount: number, bigEvery: number): boolean {
    return smallCount >= bigEvery;
}

/** UI 状态行「再聊 x 轮触发小总结」：与自动触发守卫同源的缺口换算（0＝已达标）。 */
export function roundsToTrigger(rawCount: number, intervalRounds: number, keepRounds: number): number {
    const deficit = intervalRounds * 2 - agedFloorCount(rawCount, keepRounds);
    return deficit <= 0 ? 0 : Math.ceil(deficit / 2);
}
