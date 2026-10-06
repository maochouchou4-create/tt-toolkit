/**
 * 池抽取纯函数：Efraimidis–Spirakis 加权无放回抽取。
 *
 * 算法出处：Efraimidis & Spirakis, "Weighted Random Sampling over Data Streams"（2005），
 * 加权无放回抽样经典做法——为每个候选计算 key = rand^(1/w)，取 key 最大的前 K 个。
 * 本文件为独立重写实现，仅引用该算法思想（AFPL：不逐行翻译 fork 代码）。
 *
 * 为什么 RNG 必须可注入：冒烟的分布断言需要种子 PRNG（mulberry32）确定性复现，
 * 运行时默认 Math.random。
 */

import type { DrawResult, PoolEntry, PinnedOverflow } from './types';

/** 可注入随机源（冒烟注种子 PRNG；运行时默认 Math.random）。 */
export type RandomSource = () => number;

/** 压到近零权的权重回退值（0/负权走此值——fork Math.max 垫底同语义）。 */
const SAFE_WEIGHT_FLOOR = 1e-9;

export function safeWeight(w: unknown): number {
    const n = typeof w === 'number' ? w : Number(w);
    // 双复核 P3 修复（fork 语义对齐）：非数值（NaN）＝坏数据回等权 1；
    // 0/负＝显式压到近零权（fork 的 Math.max(w, 0.0001) 垫底——0 权条目
    // 几乎抽不中＝「实质禁用」意图，而不是等权参与）
    if (!Number.isFinite(n)) return 1;
    if (n <= 0) return SAFE_WEIGHT_FLOOR;
    return n;
}

/** Fisher–Yates 洗牌（原地）。数组顺序本身就是输入的一部分，不可省。 */
function shuffle<T>(arr: T[], random: RandomSource): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * Efraimidis–Spirakis 加权无放回抽 K 条：key = random^(1/max(w,ε))，降序取前 K。
 * 先洗牌是必须的：同 key 并列或输入有序时，前缀条目会被系统性偏向。
 */
function weightedSample<T extends { weight: number }>(items: T[], amount: number, random: RandomSource): T[] {
    if (amount <= 0 || items.length === 0) return [];
    const pool = shuffle([...items], random);
    const keyed = pool.map((it) => ({
        it,
        key: Math.pow(random(), 1 / Math.max(safeWeight(it.weight), SAFE_WEIGHT_FLOOR)),
    }));
    keyed.sort((a, b) => b.key - a.key);
    return keyed.slice(0, Math.min(amount, items.length)).map((k) => k.it);
}

/**
 * 候选抽取量数学：remaining + ceil(remaining×pct/100)，封顶池大小（抽不出多于池里有的）。
 * remaining = max(count - pinned.length, 0)：pinned 已超额时不再补抽（超发语义由 overflow 策略管）。
 */
export function drawAmount(remaining: number, oversamplePct: number, poolSize: number): number {
    const pct = Number.isFinite(oversamplePct) && oversamplePct > 0 ? oversamplePct : 0;
    const want = remaining + Math.ceil((remaining * pct) / 100);
    return Math.min(want, poolSize);
}

/**
 * 核心抽取：pinned 全发（trim 策略=打乱后截 count）；非 pinned 加权抽取（可超额、可分桶轮询）。
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
        drawn = weightedSample(candidates, amount, random);
    }

    if (shuffleFinal) {
        shuffle(pinned, random);
        shuffle(drawn, random);
    }
    return { pinned, drawn };
}

/**
 * 分桶轮询：按 category 分桶、桶序随机，逐桶轮转抽一条（桶内加权抽 1）。
 * 保证覆盖多个桶——单一重权桶不能垄断候选区。
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
        const [picked] = weightedSample(bucket, 1, random);
        if (!picked) continue;
        out.push(picked);
        const idx = bucket.indexOf(picked);
        bucket.splice(idx, 1);
    }
    return out;
}
