/**
 * 旧版数据一键导入（批C）＋本仓 JSON 备份导出/导入。
 *
 * 旧数据实证形状（用户 settings.json 的 extension_settings.choice，导入映射照此设计；
 * 代码与报告不写入真实密钥——密钥只是被搬运的字符串，不落地到本文件）：
 * - master_pool: [{id(部分尾部带 \r), category, type, content, rule(已弃), pinned, weight}]
 * - configs: [{id, name, is_default, rules(已弃——池规则并入提示词模板), entries:[{entry_id(部分带 \r), enabled,
 *   pinned, weight}], generation:{categories_enabled, count_mode:"4", dedup_enabled,
 *   dedup_threshold, oversample_pct, pinned_overflow, shuffle_final}}]
 * - apis: [{id, name, apiurl, key, model, stream, temperature, max_tokens,
 *   exclude_params, timeout}]
 * - active_api_id / auto_generate
 * - 其余键不导入，进「已忽略字段」报告清单。
 *
 * 整合轮II：旧档 apis[] 的端点身份（url/key/model）导入统一端点表
 * （modules/apis），stream/temperature/max_tokens 归 choice 任务域；本仓
 * 备份 v2 随之携带统一端点表全量＋choice 任务参数＋选中端点引用。
 */

import { extension_settings } from '@/host';
import { choiceStorage, DEFAULT_TASK_PARAMS, type ChoiceTaskParams } from '../api';
import type { ApiEndpoint } from '@/modules/apis/types';
import { mutateApiDomain, readApiDomain } from '@/modules/apis/storage';
import { normalizePoolConfig, normalizePoolEntry } from './normalize';
import { readPoolData, upsertPoolConfig, upsertPoolEntry } from './storage';
import type { PoolConfig, PoolEntry, PoolGenParams } from './types';

/** 导入结果报告（UI/冒烟都消费这份）。 */
export interface PoolImportReport {
    masterPoolImported: number;
    masterPoolSkipped: number;
    configsImported: number;
    configsSkipped: number;
    /** 端点表导入计数（含旧档 apis 与备份 endpoints 两条来路）。 */
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

/** count 值域钳制（与 ChoiceSettingsTab 的 UI 钳制同域 1-10）。 */
function clampCount(n: number): number {
    return Math.min(Math.max(Math.trunc(n), 1), 10);
}

/** 任务参数白名单守门（导入/备份两条入口共用；畸形值回落缺省）。 */
function sanitizeTaskParams(raw: Partial<Record<keyof ChoiceTaskParams, unknown>>): ChoiceTaskParams {
    return {
        outputContract: raw.outputContract === 'json_schema' || raw.outputContract === 'prompt_only' ? raw.outputContract : 'json_object',
        reasoningEffort: raw.reasoningEffort === 'low' || raw.reasoningEffort === 'medium' || raw.reasoningEffort === 'high' ? raw.reasoningEffort : 'off',
        stream: typeof raw.stream === 'boolean' ? raw.stream : DEFAULT_TASK_PARAMS.stream,
        temperature: asFiniteNumber(raw.temperature) ?? DEFAULT_TASK_PARAMS.temperature,
        maxTokens: asFiniteNumber(raw.maxTokens) ?? DEFAULT_TASK_PARAMS.maxTokens,
    };
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
 * 端点写入经 mutateApiDomain（读-改-写单通道）；choice 域经 writeDomain。
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

    // 1) master_pool：逐条规范化（id trim 去重）
    const seenEntryIds = new Set<string>();
    let legacyEntryRuleNoted = false;
    for (const raw of asArray(legacy.master_pool)) {
        const rawRecord = asRecord(raw);
        if (!legacyEntryRuleNoted && rawRecord && typeof rawRecord.rule === 'string' && rawRecord.rule.trim()) {
            legacyEntryRuleNoted = true;
            report.notes.push('条目级规则已弃（池规则并入提示词模板），导入时丢弃');
        }
        const entry = normalizePoolEntry(raw);
        if (!entry) {
            report.notes.push('一条池条目缺 id（或形状不对）被丢弃');
            continue;
        }
        if (seenEntryIds.has(entry.id)) {
            report.masterPoolSkipped++;
            report.notes.push(`池条目 id 规范化后重复（${entry.id}），保留首见条目（内容以首条为准）`);
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
            entries: asArray(record.entries).map(e => {
                const ref = asRecord(e);
                // entry_id 与池条目 id 两端一致 trim 规范化（normalizePoolConfigEntry 内做）
                return ref ? { entryId: ref.entry_id, enabled: ref.enabled, pinned: ref.pinned, weight: ref.weight } : null;
            }),
        });
        if (!config) continue;
        // 池规则已并入提示词模板写作规则（m03359 拍板）——旧档的 rules
        // 不再是独立注入段，导入时丢弃并报告
        if ('rules' in record) report.ignoredFields.push('configs[].rules（池规则已并入提示词模板，忽略）');
        // 抽取参数优先取默认配置；旧档若无 is_default 标记，则退回首个带
        // generation 块的配置（兜底落点——旧档实证只有一套全默认配置）
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

    // 3) apis → 统一端点表（端点身份直映；exclude_params/timeout 忽略并
    //    报告；任务参数 outputContract/reasoningEffort 旧档没有，缺省
    //    json_object/off——stream/temperature/max_tokens 依选中端点进任务域）
    const importedEndpoints: Array<{ id: string; task: ChoiceTaskParams }> = [];
    {
        const existingApiIds = new Set(readApiDomain().map(e => e.id));
        const pending: ApiEndpoint[] = [];
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
            pending.push({
                id,
                name: typeof record.name === 'string' ? record.name : id,
                url: typeof record.apiurl === 'string' ? record.apiurl : '',
                key: typeof record.key === 'string' ? record.key : '',
                model: typeof record.model === 'string' ? record.model : '',
            });
            importedEndpoints.push({
                id,
                task: sanitizeTaskParams({
                    stream: record.stream,
                    temperature: record.temperature,
                    maxTokens: record.max_tokens,
                }),
            });
            existingApiIds.add(id);
            report.apisImported++;
        }
        if (pending.length > 0) {
            mutateApiDomain(endpoints => {
                endpoints.push(...pending);
            });
        }
    }

    // 4) active_api_id / auto_generate / count_mode → gen＋任务域
    // active_api_id 先 trim（P2-2：legacy 值可能带 \r，与已 trim 的端点 id
    // 比较会静默失配——trim 后再判命中；失配记 notes 提示用户手动重选）
    const legacyActiveApiId = typeof legacy.active_api_id === 'string' ? legacy.active_api_id.trim() : '';
    const legacyActiveTask = importedEndpoints.find(e => e.id === legacyActiveApiId)?.task;
    choiceStorage.writeDomain(d => {
        if (legacyCount !== null) {
            const clamped = clampCount(legacyCount);
            if (clamped !== legacyCount) report.notes.push(`count_mode ${legacyCount} 超出 1-10，已钳到 ${clamped}`);
            d.gen.count = clamped;
        }
        if (legacyGen.oversamplePct !== undefined) d.gen.oversamplePct = legacyGen.oversamplePct;
        if (legacyGen.categoriesEnabled !== undefined) d.gen.categoriesEnabled = legacyGen.categoriesEnabled;
        if (legacyGen.pinnedOverflow !== undefined) d.gen.pinnedOverflow = legacyGen.pinnedOverflow;
        if (legacyGen.shuffleFinal !== undefined) d.gen.shuffleFinal = legacyGen.shuffleFinal;
        if (typeof legacy.auto_generate === 'boolean') d.gen.autoGenerate = legacy.auto_generate;
        // active_api_id → 统一端点引用（命中已存在/本次导入的 id 才生效，防悬空指向）；
        // 选中端点的旧任务参数（流式/温度/max_tokens）一并带进任务域
        if (legacyActiveApiId && readApiDomain().some(e => e.id === legacyActiveApiId)) {
            d.activeEndpointId = legacyActiveApiId;
            if (legacyActiveTask) d.task = { ...d.task, ...legacyActiveTask };
        }
    });
    if (legacyActiveApiId && !readApiDomain().some(e => e.id === legacyActiveApiId)) {
        report.notes.push('active_api_id 未命中任何已导入端点——未自动选中端点，请在选项生成 tab 手动选择');
    }

    const summary = `旧数据导入：${report.masterPoolImported} 条池条目（跳过 ${report.masterPoolSkipped}）、${report.configsImported} 套池配置、${report.apisImported} 个端点${report.ignoredFields.length > 0 ? `；忽略字段 ${report.ignoredFields.length} 项` : ''}`;
    console.info(`[tt-toolkit][pool] ${summary}`);
    return report;
}

/** 本仓备份形状（池＋池配置＋抽取参数＋统一端点表＋choice 任务参数；自备份用）。 */
export interface PoolBackup {
    kind: 'tt-toolkit-pool-backup';
    version: 2;
    masterPool: PoolEntry[];
    poolConfigs: PoolConfig[];
    gen: Partial<PoolGenParams> & { count?: number };
    /** 统一端点表全量快照（端点为全局资源，跨任务共享）。 */
    endpoints: ApiEndpoint[];
    /** choice 任务参数（与 activeEndpointId 一起还原生成通道）。 */
    choiceTask: ChoiceTaskParams;
    activeEndpointId: string;
}

/** 导出本仓池数据为 JSON 字符串（含端点表——自备份口径与导入对齐）。 */
export function exportPoolBackup(): string {
    const d = choiceStorage.readDomain();
    const backup: PoolBackup = {
        kind: 'tt-toolkit-pool-backup',
        version: 2,
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
        endpoints: readApiDomain(),
        choiceTask: d.task,
        activeEndpointId: d.activeEndpointId,
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
    if (record.version !== 1 && record.version !== 2) return { ok: false, error: '版本不支持' };
    const hasArrays = (version: number): boolean => {
        const poolOk = Array.isArray(record.masterPool) && Array.isArray(record.poolConfigs);
        return version === 1 ? poolOk && Array.isArray(record.apis) : poolOk && Array.isArray(record.endpoints);
    };
    if (!hasArrays(record.version)) {
        return record.version === 1
            ? { ok: false, error: 'masterPool/poolConfigs/apis 必须是数组' }
            : { ok: false, error: 'masterPool/poolConfigs/endpoints 必须是数组' };
    }
    // v1（整合轮II 前的自备份：apis[] 为 choice 域 ApiConfig 形状）在此
    // 升格为 v2——端点身份进端点表，任务参数从选中条目派生
    if (record.version === 1) {
        const apis = asArray(record.apis).map(asRecord).filter((r): r is Record<string, unknown> => r !== null && typeof r.id === 'string');
        const active = apis.find(a => String(a.id).trim() === (typeof record.activeApiId === 'string' ? record.activeApiId.trim() : ''));
        const data: PoolBackup = {
            kind: 'tt-toolkit-pool-backup',
            version: 2,
            masterPool: record.masterPool as PoolEntry[],
            poolConfigs: record.poolConfigs as PoolConfig[],
            gen: (asRecord(record.gen) ?? {}) as PoolBackup['gen'],
            endpoints: apis.map(a => ({
                id: String(a.id).trim(),
                name: typeof a.name === 'string' ? a.name : String(a.id).trim(),
                url: typeof a.apiurl === 'string' ? a.apiurl : '',
                key: typeof a.key === 'string' ? a.key : '',
                model: typeof a.model === 'string' ? a.model : '',
            })),
            choiceTask: sanitizeTaskParams({
                outputContract: active?.outputContract,
                reasoningEffort: active?.reasoningEffort,
                stream: active?.stream,
                temperature: active?.temperature,
                maxTokens: active?.maxTokens,
            }),
            activeEndpointId: typeof record.activeApiId === 'string' ? record.activeApiId.trim() : '',
        };
        return { ok: true, data };
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
    const existingApiIds = new Set(readApiDomain().map(e => e.id));
    {
        const pending: ApiEndpoint[] = [];
        for (const raw of data.endpoints) {
            const record = asRecord(raw);
            if (!record || typeof record.id !== 'string') continue;
            const id = record.id.trim();
            if (!id || existingApiIds.has(id)) {
                report.apisSkipped++;
                continue;
            }
            // 白名单校验（双复核 P3 纪律：这是唯一能把外部数据直通统一端点
            // 表的路径——畸形备份不得带非字符串字段进表）
            pending.push({
                id,
                name: typeof record.name === 'string' ? record.name : id,
                url: typeof record.url === 'string' ? record.url : '',
                key: typeof record.key === 'string' ? record.key : '',
                model: typeof record.model === 'string' ? record.model : '',
            });
            existingApiIds.add(id);
            report.apisImported++;
        }
        if (pending.length > 0) {
            mutateApiDomain(endpoints => {
                endpoints.push(...pending);
            });
        }
    }
    choiceStorage.writeDomain(d => {
        if (Number.isFinite(data.gen?.count)) {
            const rawCount = data.gen.count as number;
            const clamped = clampCount(rawCount);
            if (clamped !== rawCount) report.notes.push(`备份 gen.count ${rawCount} 超出 1-10，已钳到 ${clamped}`);
            d.gen.count = clamped;
        }
        const gen = data.gen ?? {};
        if (Number.isFinite(gen.oversamplePct)) d.gen.oversamplePct = gen.oversamplePct as number;
        if (typeof gen.categoriesEnabled === 'boolean') d.gen.categoriesEnabled = gen.categoriesEnabled;
        if (gen.pinnedOverflow === 'send_all' || gen.pinnedOverflow === 'trim') d.gen.pinnedOverflow = gen.pinnedOverflow;
        if (typeof gen.shuffleFinal === 'boolean') d.gen.shuffleFinal = gen.shuffleFinal;
        if (typeof gen.autoGenerate === 'boolean') d.gen.autoGenerate = gen.autoGenerate;
        // 任务参数白名单守门后并入（畸形值回落现值，不整段覆盖）
        d.task = { ...d.task, ...sanitizeTaskParams(data.choiceTask ?? {}) };
        if (typeof data.activeEndpointId === 'string' && readApiDomain().some(e => e.id === data.activeEndpointId)) {
            d.activeEndpointId = data.activeEndpointId;
        }
    });
    return report;
}
