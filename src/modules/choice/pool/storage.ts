/**
 * 池存储层：只读读侧＋生成用现场抽取。
 *
 * 读通道经 api.ts 的 readDomain——choice 域单一读写点，读侧的 normalizePoolData
 * 缺省合并保证旧存档无字段不崩。条目池是只读资产（default-pool.json 唯一真相
 * 源，经 pool/asset.ts 同步落地），用户写面不存在，本层不再提供 CRUD。
 */

import { choiceStorage } from '../api';
import { resolvePool } from './resolver';
import type { PoolEntry, PoolInjection } from './types';

/** 读池数据（规范化后的副本）。 */
export function readPoolData(): { masterPool: PoolEntry[] } {
    return choiceStorage.readDomain().pool;
}

/**
 * 生成管线现场抽取：全池为候选（条目自身 pinned/weight 为真值）。
 * 每次生成重新抽（pinned 恒在）；RNG 用 Math.random（冒烟直接调 resolvePool 注种子）。
 */
export function drawPoolInjection(): PoolInjection {
    const domain = choiceStorage.readDomain();
    const { gen, pool } = domain;
    const result = resolvePool({
        pool: pool.masterPool,
        count: gen.count,
        categoriesEnabled: gen.categoriesEnabled,
        pinnedOverflow: gen.pinnedOverflow,
        oversamplePct: gen.oversamplePct,
        shuffleFinal: gen.shuffleFinal,
        random: Math.random,
    });
    return {
        pinned: result.pinned,
        drawn: result.drawn,
    };
}
