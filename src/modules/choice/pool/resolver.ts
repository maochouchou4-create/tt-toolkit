/**
 * 池抽取纯函数：等权无放回抽取（Fisher–Yates 洗牌取前 K）。
 *
 * 为什么 RNG 必须可注入：冒烟的分布断言需要种子 PRNG（mulberry32）确定性复现，
 * 运行时默认 Math.random。
 */

import type { DrawResult, PoolEntry, PinnedOverflow } from './types';

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
 * 超额量核心：base＋ceil(base×pct/100)；非正/非有限倍率按 0 计（与钳制面的
 * 合法域语义一致）。抽取量与注入行数估算共用这一份实现，两式不会分家。
 */
function oversampledAmount(base: number, oversamplePct: number): number {
    const pct = Number.isFinite(oversamplePct) && oversamplePct > 0 ? oversamplePct : 0;
    return base + Math.ceil((base * pct) / 100);
}

/**
 * 候选抽取量数学：remaining + ceil(remaining×pct/100)，封顶池大小（抽不出多于池里有的）。
 * remaining = max(count - pinned.length, 0)：pinned 已超额时不再补抽（超发语义由 overflow 策略管）。
 */
export function drawAmount(remaining: number, oversamplePct: number, poolSize: number): number {
    return Math.min(oversampledAmount(remaining, oversamplePct), poolSize);
}

/**
 * 注入行数估算（设置页信息行的单源公式）：置顶区＋抽取基数（count−pinned）＋其超额。
 * 不封顶：估算面无池大小入参，条数≤10、倍率≤500 时恒小于池大小（无需封顶展示）。
 */
export function estimateInjectionLines(count: number, pinned: number, oversamplePct: number): number {
    return pinned + oversampledAmount(Math.max(count - pinned, 0), oversamplePct);
}

/**
 * 核心抽取：pinned 全发（trim 策略=打乱后截 count）；非 pinned 等权抽取（可超额、可分桶轮询）。
 * shuffleFinal 时分别打乱两区（不打乱则保持输入顺序，分桶轮询时桶序本身随机）。
 */
export function resolvePool(input: {
    pool: PoolEntry[];
    count: number;
    categoriesEnabled: boolean;
    pinnedOverflow: PinnedOverflow;
    oversamplePct: number;
    shuffleFinal: boolean;
    random: RandomSource;
}): DrawResult {
    const { pool, count, categoriesEnabled, pinnedOverflow, oversamplePct, shuffleFinal, random } = input;
    const pinnedAll = pool.filter((e) => e.pinned);
    const candidates = pool.filter((e) => !e.pinned);

    let pinned: PoolEntry[];
    if (pinnedOverflow === 'trim' && pinnedAll.length > count) {
        // trim：打乱后截 count——固定打乱避免「永远砍掉同一批」，保留下来的 pinned 仍是全量里随机的一组
        pinned = shuffle([...pinnedAll], random).slice(0, Math.max(count, 0));
    } else {
        pinned = [...pinnedAll];
    }

    // pinned 已超额时 remaining 归零：不再从候选里抽（候选给 AI 只是浪费上下文）
    const remaining = Math.max(count - pinned.length, 0);
    const amount = drawAmount(remaining, oversamplePct, candidates.length);

    let drawn: PoolEntry[];
    if (categoriesEnabled) {
        drawn = drawByCategories(candidates, amount, random);
    } else {
        drawn = sampleWithoutReplacement(candidates, amount, random);
    }

    if (shuffleFinal) {
        shuffle(pinned, random);
        shuffle(drawn, random);
    }
    return { pinned, drawn };
}

/**
 * 分桶轮询：按 category 分桶、桶序随机，逐桶轮转抽一条（桶内随机抽 1）。
 * 保证覆盖多个桶——单一大桶不能垄断候选区。
 */
function drawByCategories(candidates: PoolEntry[], amount: number, random: RandomSource): PoolEntry[] {
    if (amount <= 0 || candidates.length === 0) return [];
    const buckets = new Map<string, PoolEntry[]>();
    for (const e of candidates) {
        const list = buckets.get(e.category);
        if (list) list.push(e);
        else buckets.set(e.category, [e]);
    }
    const bucketList = shuffle([...buckets.values()], random);
    const out: PoolEntry[] = [];
    // 轮询游标：一圈不够（oversample 超额）就再来一圈，直到抽满或桶全空
    let cursor = 0;
    while (out.length < amount && bucketList.some((b) => b.length > 0)) {
        const bucket = bucketList[cursor % bucketList.length];
        cursor++;
        if (bucket.length === 0) continue;
        const [picked] = sampleWithoutReplacement(bucket, 1, random);
        if (!picked) continue;
        out.push(picked);
        const idx = bucket.indexOf(picked);
        bucket.splice(idx, 1);
    }
    return out;
}
