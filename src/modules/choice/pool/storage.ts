/**
 * 池存储层（批C）：池条目/池配置 CRUD、chat 域绑定、生成用快照。
 *
 * 写通道全部经 api.ts 的 readDomain/writeDomain——choice 域单一写入点，
 * 读侧的 normalizePoolData 缺省合并保证旧存档无字段不崩。
 */

import { getChat, setChat } from '@/storage';
import { choiceStorage } from '../api';
import { effectivePool, resolvePool, resolvePoolConfig } from './resolver';
import { normalizePoolConfig, normalizePoolEntry } from './normalize';
import type { PoolConfig, PoolEntry, PoolInjection } from './types';

/** chat 域绑定键（空串＝用默认配置）。 */
const CHAT_POOL_CONFIG_KEY = 'poolConfigId';

function newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 读池数据（规范化后的副本）。 */
export function readPoolData(): { masterPool: PoolEntry[]; poolConfigs: PoolConfig[] } {
    return choiceStorage.readDomain().pool;
}

function writePoolData(mutate: (pool: { masterPool: PoolEntry[]; poolConfigs: PoolConfig[] }) => void): void {
    choiceStorage.writeDomain(d => {
        mutate(d.pool);
    });
}

export function createPoolEntry(): PoolEntry {
    return {
        id: newId('entry'),
        type: '',
        content: '',
        category: '',
        pinned: false,
        weight: 1,
    };
}

/** 增改池条目（按 id 整体替换；内容层唯一真相源）。写前再过一遍规范化。 */
export function upsertPoolEntry(entry: PoolEntry): void {
    const normalized = normalizePoolEntry(entry);
    if (!normalized) return;
    writePoolData(p => {
        const idx = p.masterPool.findIndex(e => e.id === normalized.id);
        if (idx >= 0) p.masterPool[idx] = normalized;
        else p.masterPool.push(normalized);
    });
}

/** 删池条目：同步清掉所有配置里对它的引用（悬空引用会在 effectivePool 被跳过，但留着只会脏数据）。 */
export function deletePoolEntry(entryId: string): void {
    writePoolData(p => {
        p.masterPool = p.masterPool.filter(e => e.id !== entryId);
        for (const config of p.poolConfigs) {
            config.entries = config.entries.filter(ref => ref.entryId !== entryId);
        }
    });
}

export function createPoolConfig(name: string): PoolConfig {
    return {
        id: newId('poolcfg'),
        name,
        isDefault: false,
        entries: [],
    };
}

/** 增改池配置（按 id 整体替换）。 */
export function upsertPoolConfig(config: PoolConfig): void {
    const normalized = normalizePoolConfig(config);
    if (!normalized) return;
    writePoolData(p => {
        const idx = p.poolConfigs.findIndex(c => c.id === normalized.id);
        if (idx >= 0) p.poolConfigs[idx] = normalized;
        else p.poolConfigs.push(normalized);
    });
}

/**
 * 删池配置。最后一个配置拒绝删除（返回 false）——绑定级联至少要有默认落点，
 * 空池语义＝全池回退而不是「配置不存在」。
 */
export function deletePoolConfig(configId: string): boolean {
    const { poolConfigs } = readPoolData();
    if (poolConfigs.length <= 1) return false;
    let ok = false;
    writePoolData(p => {
        const target = p.poolConfigs.find(c => c.id === configId);
        if (!target) return;
        if (p.poolConfigs.length <= 1) return;
        p.poolConfigs = p.poolConfigs.filter(c => c.id !== configId);
        // 删的是默认配置：让剩下第一个顶上默认（级联兜底点不能空）
        if (target.isDefault && p.poolConfigs.length > 0) {
            p.poolConfigs[0].isDefault = true;
        }
        ok = true;
    });
    return ok;
}

/** 置默认配置（原默认转普通——默认必须唯一，否则级联兜底有歧义）。 */
export function setDefaultPoolConfig(configId: string): void {
    writePoolData(p => {
        for (const config of p.poolConfigs) {
            config.isDefault = config.id === configId;
        }
    });
}

/** chat 域绑定读（空串＝默认；chat 域立即落盘语义见 host/settings.ts 头注释）。 */
export function readChatPoolConfigId(): string {
    const raw = getChat<{ poolConfigId?: unknown }>(CHAT_POOL_CONFIG_KEY);
    return typeof raw?.poolConfigId === 'string' ? raw.poolConfigId : '';
}

export function setChatPoolConfigId(configId: string): void {
    setChat(CHAT_POOL_CONFIG_KEY, { poolConfigId: configId });
}

/**
 * 生成管线快照：绑定级联（chat 命中→默认回退）→ effectivePool → 现场抽取。
 * 每次生成重新抽（pinned 恒在）；RNG 用 Math.random（冒烟直接调 resolvePool 注种子）。
 */
export function drawPoolInjection(): PoolInjection {
    const domain = choiceStorage.readDomain();
    const { gen, pool } = domain;
    const config = resolvePoolConfig(pool.poolConfigs, readChatPoolConfigId());
    const effective = effectivePool(pool.masterPool, config);
    const result = resolvePool({
        pool: effective,
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
