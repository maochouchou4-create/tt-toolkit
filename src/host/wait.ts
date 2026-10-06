/**
 * 宿主资源三段等待单点（立查 → APP_READY → 轮询兜底）。
 *
 * 核实记录：APP_READY 是 autoFire 事件——晚订阅会被宿主 EventEmitter
 * 同步立即重放（scripts/events.js EventEmitter 语义，host/events.ts 头注），
 * 因此「资源晚于订阅就绪」不悬挂；「APP_READY 已发而资源仍缺席」＝宿主
 * 侧确实没建（如 QR 扩展被禁用），只能靠轮询兜底到 deadline。
 */

import { eventBus, event_types } from './events';

export interface WaitResourceOptions {
    /** 轮询间隔（毫秒）。 */
    intervalMs: number;
    /** 轮询基数：总等待时长＝intervalMs × maxTries。 */
    maxTries: number;
}

/**
 * 等待 probe 命中（非 null/undefined 即命中）：立查命中直接返回；否则
 * 订阅 APP_READY（同步重放立即复测）＋轮询到 deadline。超时即放弃——
 * deadline 后不再等晚到 APP_READY（旧实现超时仍挂监听属泄漏，本实现
 * 随 finish 摘除）。返回 null。
 * 单一出口 finish 自清 APP_READY 订阅与轮询——APP_READY 晚订阅的同步
 * 重放可能先于 setInterval 创建而 settle，此时不再起轮询（防 detached
 * 计时器空转到 deadline）。
 */
export async function waitForResource<T>(
    probe: () => T | null | undefined,
    opts: WaitResourceOptions,
): Promise<T | null> {
    const hit = (): boolean => {
        const v = probe();
        return v !== null && v !== undefined;
    };
    if (hit()) return probe() as T;

    await new Promise<void>(resolve => {
        let settled = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            eventBus.removeListener(event_types.APP_READY, finish);
            if (timer !== null) clearInterval(timer);
            resolve();
        };
        eventBus.once(event_types.APP_READY, finish);
        const deadline = Date.now() + opts.intervalMs * opts.maxTries;
        timer = setInterval(() => {
            if (hit() || Date.now() >= deadline) finish();
        }, opts.intervalMs);
    });
    const result = probe();
    return result !== null && result !== undefined ? result : null;
}
