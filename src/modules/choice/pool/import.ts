/**
 * 旧版数据一键导入（批C）＋本仓 JSON 备份导出/导入。
 *
 * 旧数据实证形状（用户 settings.json 的 extension_settings.choice，导入映射照此设计；
 * 代码与报告不写入真实密钥——密钥只是被搬运的字符串，不落地到本文件）：
 * - master_pool: [{id(部分尾部带 \r), category, type, content, rule, pinned, weight}]
 * - configs: [{id, name, is_default, rules, entries:[{entry_id(部分带 \r), enabled,
 *   pinned, weight}], generation:{categories_enabled, count_mode:"4", dedup_enabled,
 *   dedup_threshold, oversample_pct, pinned_overflow, shuffle_final}}]
 * - apis: [{id, name, apiurl, key, model, stream, temperature, max_tokens,
 *   exclude_params, timeout}]
 * - active_api_id / auto_generate
 * - 其余键不导入，进「已忽略字段」报告清单。
 */

import { extension_settings } from '@/host';
import { choiceStorage, type ApiConfig } from '../api';
import { normalizePoolConfig, normalizePoolEntry } from './normalize';
import { readPoolData, upsertPoolConfig, upsertPoolEntry } from './storage';
import type { PoolConfig, PoolEntry, PoolGenParams } from './types';

/** 导入结果报告（UI/冒烟都消费这份）。 */
export interface PoolImportReport {
    masterPoolImported: number;
    masterPoolSkipped: number;
    configsImported: number;
    configsSkipped: number;
    apisImported: number;
    apisSkipped: number;
    /** 顶层未识别键＋已知砍掉的嵌套字段，逐项列名。 */
    ignoredFields: string[];
    /** 非致命提示（如 count_mode 非数字）。 */
    notes: string[];
}

const KNOWN_TOP_KEYS = new Set(['master_pool', 'configs', 'apis', 'active_api_id', 'auto_generate']);

function asRecord(v: unknown): Record<string, unknown> | null {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function asBool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

function asFiniteNumber(v: unknown): number | null {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
}

/**
 * 读旧版 extension_settings.choice。旧插件数据就挂在这个全局可变单例下
 * （核实记录见 host/settings.ts 头注释），运行时直接读，无需额外 API。
 * 无数据/形状不对返回 null。
 */
export function readLegacyChoice(): Record<string, unknown> | null {
    const legacy = asRecord(extension_settings.choice);
    return legacy;
}

/**
 * 旧数据一键导入。幂等：按 id 去重，已存在的 id 跳过（不覆盖用户后续编辑）。
 * 写入经 upsert（读-改-写单通道）。
 */
export function importLegacyChoice(): PoolImportReport | null {
    const legacy = readLegacyChoice();
    if (!legacy) return null;

    const report: PoolImportReport = {
        masterPoolImported: 0,
        masterPoolSkipped: 0,
        configsImported: 0,
        configsSkipped: 0,
        apisImported: 0,
        apisSkipped: 0,
        ignoredFields: [],
        notes: [],
    };

    // 顶层未知键→已忽略字段清单（截前 20 个防刷屏）
    for (const key of Object.keys(legacy)) {
        if (!KNOWN_TOP_KEYS.has(key)) report.ignoredFields.push(key);
    }

    const existingPool = readPoolData();
    const existingEntryIds = new Set(existingPool.masterPool.map(e => e.id));
    const existingConfigIds = new Set(existingPool.poolConfigs.map(c => c.id));
    const existingApiIds = new Set(choiceStorage.readDomain().apis.map(a => a.id));

    // 1) master_pool：逐条规范化（id trim 去重）
    const seenEntryIds = new Set<string>();
    for (const raw of asArray(legacy.master_pool)) {
        const entry = normalizePoolEntry(raw);
        if (!entry) {
            report.notes.push('一条池条目缺 id（或形状不对）被丢弃');
            continue;
        }
        if (seenEntryIds.has(entry.id)) {
            report.masterPoolSkipped++;
            report.notes.push(`池条目 id 规范化后重复（${entry.id}），保留首条`);
            continue;
        }
        seenEntryIds.add(entry.id);
        if (existingEntryIds.has(entry.id)) {
            report.masterPoolSkipped++;
            continue;
        }
        upsertPoolEntry(entry);
        existingEntryIds.add(entry.id);
        report.masterPoolImported++;
    }

    // 2) configs → 池配置（引用层，generation 抽取参数并入全局 gen）
    const legacyGen: Partial<PoolGenParams> = {};
    let legacyCount: number | null = null;
    let sawGenBlock = false;
    for (const raw of asArray(legacy.configs)) {
        const record = asRecord(raw);
        if (!record) continue;
        const config = normalizePoolConfig({
            id: record.id,
            name: record.name,
            isDefault: record.is_default,
            rules: record.rules,
            entries: asArray(record.entries).map(e => {
                const ref = asRecord(e);
                // entry_id 与池条目 id 两端一致 trim 规范化（normalizePoolConfigEntry 内做）
                return ref ? { entryId: ref.entry_id, enabled: ref.enabled, pinned: ref.pinned, weight: ref.weight } : null;
            }),
        });
        if (!config) continue;
        // 抽取参数只从默认配置取（绑定级联的兜底落点；旧档实证只有一套全默认配置）
        const isDefault = asBool(record.is_default, false);
        const generation = asRecord(record.generation);
        if (generation && (isDefault || !sawGenBlock)) {
            sawGenBlock = true;
            const countMode = asFiniteNumber(generation.count_mode);
            if (countMode !== null) legacyCount = countMode;
            else report.notes.push('count_mode 不是数字，沿用现有 count');
            const oversample = asFiniteNumber(generation.oversample_pct);
            if (oversample !== null) legacyGen.oversamplePct = oversample;
            legacyGen.categoriesEnabled = asBool(generation.categories_enabled, false);
            if (generation.pinned_overflow === 'send_all' || generation.pinned_overflow === 'trim') {
                legacyGen.pinnedOverflow = generation.pinned_overflow;
            }
            legacyGen.shuffleFinal = asBool(generation.shuffle_final, true);
            if ('dedup_enabled' in generation) report.ignoredFields.push('configs[].generation.dedup_enabled（输出层去重未平移，忽略）');
            if ('dedup_threshold' in generation) report.ignoredFields.push('configs[].generation.dedup_threshold（输出层去重未平移，忽略）');
        }
        if (existingConfigIds.has(config.id)) {
            report.configsSkipped++;
            continue;
        }
        upsertPoolConfig(config);
        existingConfigIds.add(config.id);
        report.configsImported++;
    }

    // 3) apis → ApiConfig 直映（exclude_params/timeout 忽略并报告；
    //    outputContract/reasoningEffort 旧档没有，缺省 json_object/off）
    for (const raw of asArray(legacy.apis)) {
        const record = asRecord(raw);
        if (!record) continue;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (!id) continue;
        if ('exclude_params' in record) report.ignoredFields.push('apis[].exclude_params（参数过滤未平移，忽略）');
        if ('timeout' in record) report.ignoredFields.push('apis[].timeout（超时策略改由统一请求层管理，忽略）');
        if (existingApiIds.has(id)) {
            report.apisSkipped++;
            continue;
        }
        const api: ApiConfig = {
            id,
            name: typeof record.name === 'string' ? record.name : id,
            apiurl: typeof record.apiurl === 'string' ? record.apiurl : '',
            key: typeof record.key === 'string' ? record.key : '',
            model: typeof record.model === 'string' ? record.model : '',
            outputContract: 'json_object',
            reasoningEffort: 'off',
            stream: asBool(record.stream, true),
            temperature: asFiniteNumber(record.temperature) ?? 0.7,
            maxTokens: asFiniteNumber(record.max_tokens) ?? 2048,
        };
        choiceStorage.upsertApi(api);
        existingApiIds.add(id);
        report.apisImported++;
    }

    // 4) active_api_id / auto_generate / count_mode → gen
    choiceStorage.writeDomain(d => {
        if (legacyCount !== null) d.gen.count = legacyCount;
        if (legacyGen.oversamplePct !== undefined) d.gen.oversamplePct = legacyGen.oversamplePct;
        if (legacyGen.categoriesEnabled !== undefined) d.gen.categoriesEnabled = legacyGen.categoriesEnabled;
        if (legacyGen.pinnedOverflow !== undefined) d.gen.pinnedOverflow = legacyGen.pinnedOverflow;
        if (legacyGen.shuffleFinal !== undefined) d.gen.shuffleFinal = legacyGen.shuffleFinal;
        if (typeof legacy.auto_generate === 'boolean') d.gen.autoGenerate = legacy.auto_generate;
        // active_api_id 直映（仅在命中已存在/本次导入的 id 时生效，防悬空指向）
        if (typeof legacy.active_api_id === 'string' && d.apis.some(a => a.id === legacy.active_api_id)) {
            d.activeApiId = legacy.active_api_id;
        }
    });

    const summary = `旧数据导入：${report.masterPoolImported} 条池条目（跳过 ${report.masterPoolSkipped}）、${report.configsImported} 套池配置、${report.apisImported} 个 API${report.ignoredFields.length > 0 ? `；忽略字段 ${report.ignoredFields.length} 项` : ''}`;
    console.info(`[tt-toolkit][pool] ${summary}`);
    return report;
}

/** 本仓备份形状（池＋池配置＋抽取参数＋API；自备份用）。 */
export interface PoolBackup {
    kind: 'tt-toolkit-pool-backup';
    version: 1;
    masterPool: PoolEntry[];
    poolConfigs: PoolConfig[];
    gen: Partial<PoolGenParams> & { count?: number };
    apis: ApiConfig[];
    activeApiId: string;
}

/** 导出本仓池数据为 JSON 字符串（含 API——自备份口径与导入对齐）。 */
export function exportPoolBackup(): string {
    const d = choiceStorage.readDomain();
    const backup: PoolBackup = {
        kind: 'tt-toolkit-pool-backup',
        version: 1,
        masterPool: d.pool.masterPool,
        poolConfigs: d.pool.poolConfigs,
        gen: {
            count: d.gen.count,
            oversamplePct: d.gen.oversamplePct,
            categoriesEnabled: d.gen.categoriesEnabled,
            pinnedOverflow: d.gen.pinnedOverflow,
            shuffleFinal: d.gen.shuffleFinal,
            autoGenerate: d.gen.autoGenerate,
        },
        apis: d.apis,
        activeApiId: d.activeApiId,
    };
    return JSON.stringify(backup, null, 2);
}

/** 解析并校验备份文本。畸形（kind/version/数组形状不对）返回 error 字符串。 */
export function parsePoolBackup(text: string): { ok: true; data: PoolBackup } | { ok: false; error: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, error: '不是合法 JSON' };
    }
    const record = asRecord(parsed);
    if (!record) return { ok: false, error: '顶层不是对象' };
    if (record.kind !== 'tt-toolkit-pool-backup') return { ok: false, error: 'kind 不匹配（不是本仓池备份）' };
    if (record.version !== 1) return { ok: false, error: '版本不支持' };
    if (!Array.isArray(record.masterPool) || !Array.isArray(record.poolConfigs) || !Array.isArray(record.apis)) {
        return { ok: false, error: 'masterPool/poolConfigs/apis 必须是数组' };
    }
    return { ok: true, data: record as unknown as PoolBackup };
}

/**
 * 导入本仓备份（幂等：按 id 去重，已存在跳过）。畸形输入应先经 parsePoolBackup 拒绝；
 * 这里再做一次逐条规范化兜底（normalize 层拒掉形状不对的单条）。
 */
export function importPoolBackup(data: PoolBackup): PoolImportReport {
    const report: PoolImportReport = {
        masterPoolImported: 0,
        masterPoolSkipped: 0,
        configsImported: 0,
        configsSkipped: 0,
        apisImported: 0,
        apisSkipped: 0,
        ignoredFields: [],
        notes: [],
    };
    const existing = readPoolData();
    const existingEntryIds = new Set(existing.masterPool.map(e => e.id));
    for (const raw of data.masterPool) {
        const entry = normalizePoolEntry(raw);
        if (!entry) continue;
        if (existingEntryIds.has(entry.id)) {
            report.masterPoolSkipped++;
            continue;
        }
        upsertPoolEntry(entry);
        existingEntryIds.add(entry.id);
        report.masterPoolImported++;
    }
    const existingConfigIds = new Set(existing.poolConfigs.map(c => c.id));
    for (const raw of data.poolConfigs) {
        const config = normalizePoolConfig(raw);
        if (!config) continue;
        if (existingConfigIds.has(config.id)) {
            report.configsSkipped++;
            continue;
        }
        upsertPoolConfig(config);
        existingConfigIds.add(config.id);
        report.configsImported++;
    }
    const existingApiIds = new Set(choiceStorage.readDomain().apis.map(a => a.id));
    for (const raw of data.apis) {
        const record = asRecord(raw);
        if (!record || typeof record.id !== 'string') continue;
        const id = record.id.trim();
        if (!id || existingApiIds.has(id)) {
            report.apisSkipped++;
            continue;
        }
        const api: ApiConfig = {
            id,
            name: typeof record.name === 'string' ? record.name : id,
            apiurl: typeof record.apiurl === 'string' ? record.apiurl : '',
            key: typeof record.key === 'string' ? record.key : '',
            model: typeof record.model === 'string' ? record.model : '',
            outputContract: record.outputContract === 'json_schema' || record.outputContract === 'prompt_only' ? record.outputContract : 'json_object',
            reasoningEffort: typeof record.reasoningEffort === 'string' ? (record.reasoningEffort as ApiConfig['reasoningEffort']) : 'off',
            stream: asBool(record.stream, true),
            temperature: asFiniteNumber(record.temperature) ?? 0.7,
            maxTokens: asFiniteNumber(record.maxTokens) ?? 2048,
        };
        choiceStorage.upsertApi(api);
        existingApiIds.add(id);
        report.apisImported++;
    }
    choiceStorage.writeDomain(d => {
        if (Number.isFinite(data.gen?.count)) d.gen.count = data.gen.count as number;
        const gen = data.gen ?? {};
        if (Number.isFinite(gen.oversamplePct)) d.gen.oversamplePct = gen.oversamplePct as number;
        if (typeof gen.categoriesEnabled === 'boolean') d.gen.categoriesEnabled = gen.categoriesEnabled;
        if (gen.pinnedOverflow === 'send_all' || gen.pinnedOverflow === 'trim') d.gen.pinnedOverflow = gen.pinnedOverflow;
        if (typeof gen.shuffleFinal === 'boolean') d.gen.shuffleFinal = gen.shuffleFinal;
        if (typeof gen.autoGenerate === 'boolean') d.gen.autoGenerate = gen.autoGenerate;
        if (typeof data.activeApiId === 'string' && d.apis.some(a => a.id === data.activeApiId)) {
            d.activeApiId = data.activeApiId;
        }
    });
    return report;
}
