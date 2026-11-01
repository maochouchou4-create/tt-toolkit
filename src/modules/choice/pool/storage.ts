/**
 * 池存储层：只读读侧＋生成用现场抽取。
 *
 * 读通道经 api.ts 的 readDomain——choice 域单一读写点，读侧的 normalizePoolData
 * 缺省合并保证旧存档无字段不崩。风格池是只读资产（default-pool.json 唯一真相
 * 源，经 pool/asset.ts 同步落地），用户写面不存在，本层不再提供 CRUD。
 */

import { choiceStorage } from '../api';
import { resolvePool } from './resolver';

/**
 * 生成管线现场抽取：抽中的候选风格名（纯随机不放回，候选可能多于实际所需）。
 * 每次生成重新抽；RNG 用 Math.random（冒烟直接调 resolvePool 注种子）。
 */
export function drawPoolInjection(): string[] {
    const domain = choiceStorage.readDomain();
    const { gen, pool } = domain;
    const drawn = resolvePool({
        pool: pool.masterPool,
        count: gen.count,
        oversamplePct: gen.oversamplePct,
        random: Math.random,
    });
    return drawn.map(e => e.name);
}
