/**
 * 池数据规范化（纯函数，无宿主依赖）。
 *
 * 为什么单独一个文件：api.ts 的 readDomain 要在这里做「旧存档缺字段不崩」的缺省
 * 合并，而 pool/storage.ts 又要用 api.ts 的 readDomain/writeDomain——规范化逻辑
 * 拆成独立纯模块，两边单向引用，不出环。
 */

import type { PoolEntry, PoolGenParams } from './types';
import { safeWeight } from './resolver';

/** choice 域下的池子对象形状。 */
export interface PoolDomainData {
    masterPool: PoolEntry[];
    /**
     * 内置池内容版本标记：default-pool.json 的 version，由 syncAssetPool 写入。
     * normalize 默认丢弃未知字段，这里显式保真——它是「内容是否需要随插件
     * 更新重刷」的判据，丢了会每次启动都重写一遍池。
     */
    assetVersion?: number;
}

export const EMPTY_POOL_DATA: PoolDomainData = { masterPool: [] };

/** 池抽取参数缺省值（与 fork 旧数据 generation 块的实测值对齐：oversample 100/send_all/shuffle）。 */
export const DEFAULT_POOL_GEN_PARAMS: PoolGenParams = {
    oversamplePct: 100,
    // 按分类轮询默认开（每轮选项尽量来自不同分类，保证多样性）。
    // 旧用户存了 false 的由 syncAssetPool 首次同步做一次性翻转，之后纯用户域。
    categoriesEnabled: true,
    pinnedOverflow: 'send_all',
    shuffleFinal: true,
    autoGenerate: true,
};

function asString(v: unknown, fallback = ''): string {
    return typeof v === 'string' ? v : fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

function asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

/** 单条池条目规范化：id trim（旧档部分 id 尾部带 \r）、缺字段补缺省、weight 走 safeWeight。 */
export function normalizePoolEntry(raw: unknown): PoolEntry | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const id = asString(r.id).trim();
    // id 为空的条目无法定位，直接丢弃
    if (!id) return null;
    return {
        id,
        type: asString(r.type),
        content: asString(r.content),
        category: asString(r.category),
        pinned: asBool(r.pinned, false),
        weight: safeWeight(r.weight),
    };
}

/**
 * 整个池子对象规范化：条目按规范化 id 去重（首见优先——旧档 trim 后可能撞 id）。
 * 旧存档的引用层（poolConfigs，v1.2.0 前的两层结构）读侧整体出局：normalize
 * 丢弃未知字段，旧键残留随下一次写通道自然清除。返回全新对象（与存档解耦）。
 */
export function normalizePoolData(raw: unknown): PoolDomainData {
    if (typeof raw !== 'object' || raw === null) return { masterPool: [] };
    const r = raw as Record<string, unknown>;
    const seen = new Set<string>();
    const masterPool: PoolEntry[] = [];
    for (const item of asArray(r.masterPool)) {
        const entry = normalizePoolEntry(item);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        masterPool.push(entry);
    }
    // assetVersion 保真（见 PoolDomainData 注释）；非 number 视为未标记（首次/异常档）。
    const assetVersion = typeof r.assetVersion === 'number' ? r.assetVersion : undefined;
    return assetVersion === undefined ? { masterPool } : { masterPool, assetVersion };
}

/**
 * gen 里池参数部分的规范化（readDomain 合并后调用——raw 不可信值钳到合法域）。
 * 泛型透传：入参带多少字段（count 等 choice 域字段）就原样保留多少。
 */
export function normalizePoolGenParams<T extends PoolGenParams>(gen: T): T {
    const rawPct = Number(gen.oversamplePct);
    const overflow = gen.pinnedOverflow;
    return {
        ...gen,
        oversamplePct: Number.isFinite(rawPct) ? Math.min(Math.max(Math.trunc(rawPct), 0), 300) : DEFAULT_POOL_GEN_PARAMS.oversamplePct,
        categoriesEnabled: asBool(gen.categoriesEnabled, DEFAULT_POOL_GEN_PARAMS.categoriesEnabled),
        pinnedOverflow: overflow === 'send_all' || overflow === 'trim' ? overflow : DEFAULT_POOL_GEN_PARAMS.pinnedOverflow,
        shuffleFinal: asBool(gen.shuffleFinal, DEFAULT_POOL_GEN_PARAMS.shuffleFinal),
        autoGenerate: asBool(gen.autoGenerate, DEFAULT_POOL_GEN_PARAMS.autoGenerate),
    };
}
