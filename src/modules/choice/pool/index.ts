/**
 * choice 池模块导出面（批C）。
 */

export type { PoolEntry, PoolConfig, PoolConfigEntry, PoolGenParams, PinnedOverflow, DrawResult, PoolInjection } from './types';
export { safeWeight, resolvePoolConfig, effectivePool, resolvePool, drawAmount, type RandomSource } from './resolver';
export { EMPTY_POOL_DATA, DEFAULT_POOL_GEN_PARAMS, normalizePoolData, normalizePoolGenParams, normalizePoolEntry, normalizePoolConfig, type PoolDomainData } from './normalize';
export {
    readPoolData,
    createPoolEntry,
    upsertPoolEntry,
    deletePoolEntry,
    createPoolConfig,
    upsertPoolConfig,
    deletePoolConfig,
    setDefaultPoolConfig,
    readChatPoolConfigId,
    setChatPoolConfigId,
    drawPoolInjection,
} from './storage';
export { readLegacyChoice, importLegacyChoice, exportPoolBackup, parsePoolBackup, importPoolBackup, type PoolImportReport, type PoolBackup } from './import';
export { usePoolStore } from './store';
