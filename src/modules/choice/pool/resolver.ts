/**
 * 池抽取纯函数：等权无放回抽取（Fisher–Yates 洗牌取前 K）。
 *
 * 风格池无固定席、无分类——整池纯随机不放回；菜单模式靠候选倍率多抽。
 * 为什么 RNG 必须可注入：冒烟的分布断言需要种子 PRNG（mulberry32）确定性复现，
 * 运行时默认 Math.random。
 */

import type { PoolEntry } from './types';

/** 可注入随机源（冒烟注种子 PRNG；运行时默认 Math.random）。 */
export type RandomSource = () => number;

/** Fisher–Yates 洗牌（原地）。数组顺序本身就是输入的一部分，不可省。 */
function shuffle<T>(arr: T[], random: RandomSource): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/** 等权无放回抽 K 条：洗牌副本取前 K——每条被抽中的概率严格均等。 */
function sampleWithoutReplacement<T>(items: T[], amount: number, random: RandomSource): T[] {
    if (amount <= 0 || items.length === 0) return [];
    return shuffle([...items], random).slice(0, Math.min(amount, items.length));
}

/**
 * 候选倍率值域唯一真源：设置页控件属性（min/max/step）与 normalize 写读钳制
 * 都从这里取——值域改一处，UI 与存档钳制不会各自漂。
 */
export const OVERSAMPLE_LIMITS = { min: 0, max: 500, step: 10 } as const;

/**
 * 候选抽取量数学：count + ceil(count×pct/100)，封顶池大小（抽不出多于池里有的）。
 * 非正/非有限倍率按 0 计（与钳制面的合法域语义一致）。
 */
export function drawAmount(count: number, oversamplePct: number, poolSize: number): number {
    const pct = Number.isFinite(oversamplePct) && oversamplePct > 0 ? oversamplePct : 0;
    const base = Math.max(count, 0);
    return Math.min(base + Math.ceil((base * pct) / 100), poolSize);
}

/**
 * 注入行数估算（设置页信息行的单源公式）：count + ceil(count×pct/100)。
 * 不封顶：估算面无池大小入参，条数≤10、倍率≤500 时恒小于池大小（无需封顶展示）。
 */
export function estimateInjectionLines(count: number, oversamplePct: number): number {
    const pct = Number.isFinite(oversamplePct) && oversamplePct > 0 ? oversamplePct : 0;
    const base = Math.max(count, 0);
    return base + Math.ceil((base * pct) / 100);
}

/**
 * 核心抽取：整池纯随机不放回（候选可超额、封顶池大小），无分区。
 */
export function resolvePool(input: {
    pool: PoolEntry[];
    count: number;
    oversamplePct: number;
    random: RandomSource;
}): PoolEntry[] {
    const { pool, count, oversamplePct, random } = input;
    const amount = drawAmount(count, oversamplePct, pool.length);
    return sampleWithoutReplacement(pool, amount, random);
}
