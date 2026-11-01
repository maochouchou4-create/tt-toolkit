/**
 * 池数据规范化（纯函数，无宿主依赖）。
 *
 * 为什么单独一个文件：api.ts 的 readDomain 要在这里做「旧存档缺字段不崩」的缺省
 * 合并，而 pool/storage.ts 又要用 api.ts 的 readDomain/writeDomain——规范化逻辑
 * 拆成独立纯模块，两边单向引用，不出环。
 */

import { type PoolEntry, type PoolGenParams } from './types';
import { OVERSAMPLE_LIMITS } from './resolver';

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

/** 池抽取参数缺省值。 */
export const DEFAULT_POOL_GEN_PARAMS: PoolGenParams = {
    /**
     * 菜单模式候选倍率：默认多抽 150%（count=4 出厂默认下抽 10 个候选风格名），
     * 候选≫所需让模型挑贴合此刻的；池大小（57）是硬封顶。注入行数公式与倍率
     * 值域的单源在 resolver（estimateInjectionLines／OVERSAMPLE_LIMITS），此处不复写。
     * 默认值只送达全新安装：存量用户的 gen
     * 早已被历史写通道物化（改任一控件或池版本变更都会整域落盘），属用户域不自动覆盖。
     */
    oversamplePct: 150,
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

/** 单条池条目规范化：id trim（旧档部分 id 尾部带 \r）、name trim（空名丢弃）、缺字段补缺省。 */
export function normalizePoolEntry(raw: unknown): PoolEntry | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const id = asString(r.id).trim();
    // id 为空的条目无法定位，直接丢弃
    if (!id) return null;
    const name = asString(r.name).trim();
    // 空风格名没有内容语义，直接丢弃
    if (!name) return null;
    return { id, name };
}

/**
 * 整个池子对象规范化：条目按规范化 id 去重（首见优先——旧档 trim 后可能撞 id）。
 * 旧条目形态（type/content/category/pinned，条目池时代）读侧整体出局：normalize
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
 * 旧档残留的退役键（categoriesEnabled/pinnedOverflow/shuffleFinal）不在此清洗——
 * 归 api 层 normalizeGenParams 七键显式重建丢弃（首读即净）。
 */
export function normalizePoolGenParams<T extends PoolGenParams>(gen: T): T {
    const rawPct = Number(gen.oversamplePct);
    return {
        ...gen,
        oversamplePct: Number.isFinite(rawPct) ? Math.min(Math.max(Math.trunc(rawPct), OVERSAMPLE_LIMITS.min), OVERSAMPLE_LIMITS.max) : DEFAULT_POOL_GEN_PARAMS.oversamplePct,
        autoGenerate: asBool(gen.autoGenerate, DEFAULT_POOL_GEN_PARAMS.autoGenerate),
    };
}
