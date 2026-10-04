/**
 * PersonaWeaver fork 存储域与旧 localStorage 迁移（批D 平移）。
 *
 * 数据落点：extension_settings.ttToolkit.persona 全局域（经 storage 层
 * getGlobal/setGlobal 单通道）。域形状 normalize 纪律照 choice/pool：
 * 未知字段丢弃（显式保真注释），缺字段补默认，反复读写幂等。
 *
 * 迁移纪律（nav 同款幂等）：域不存在→读 5 个旧键搬入新域→保留旧键
 * 作 legacy 快照（回滚旧版本不丢存量；新版本不再写旧键）→退休键
 * removeItem；域已存在→跳过迁移（二次启动零重写）。
 *
 * MODIFICATIONS（相对上游 fork）：
 * - 旧「每键直写 localStorage」改为域写单通道；写时机从 1.2s 防抖热存
 *   改为显式保存点（保存/落地按钮，见 store.ts）。
 * - pw_state_v20 的 localConfig 兼容收进域 localConfig（字段全家平移，
 *   apiProfiles 收档迁移幂等语义保留）。
 */

import { getGlobal, setGlobal } from '@/storage/service';

/** persona 域键（extension_settings.ttToolkit 下）。 */
export const PERSONA_DOMAIN_KEY = 'persona';

/** 旧 localStorage 键（一经发布不可改名——用户浏览器存量数据契约）。 */
export const LEGACY_KEYS = {
    state: 'pw_state_v20',
    wiSelection: 'pw_wi_selection_v1',
    uiState: 'pw_ui_state_v4_preset',
    dataUser: 'pw_data_user_v1',
    pinnedBooks: 'pw_pinned_books_v1',
} as const;

/** 已删除特性独占的退休键（loadData 逐次 removeItem 幂等清理存量）。 */
export const RETIRED_KEYS = [
    'pw_template_v6_new_yaml',
    'pw_avatar_images_v1',
    'pw_data_npc_v1',
    'pw_history_v29_new_template',
    'pw_prompts_v21_restore_edit',
    'pw_custom_themes_v1',
] as const;

/** 思考强度档位（'off'＝不注入 reasoning_effort 字段）。 */
export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high';

/** API 来源（主 API＝宿主 generateRaw；独立 API＝api.ts 纯 fetch）。 */
export type ApiSource = 'main' | 'independent';

/** 独立 API 配置档（apiProfiles 数组元素）。 */
export interface ApiProfile {
    id: string;
    name: string;
    url: string;
    key: string;
    model: string;
}

/** 独立 API 配置（localConfig 的 API 面，默认值同旧 defaultSettings）。 */
export interface LocalConfig {
    apiSource: ApiSource;
    indepApiUrl: string;
    indepApiKey: string;
    indepApiModel: string;
    /** 请求超时秒数（钳制 30..1800）。 */
    indepTimeout: number;
    indepStream: boolean;
    thinkingEffort: ThinkingEffort;
    /** 追加参考世界书（钉选+本会话手动添加）。 */
    extraBooks: string[];
    apiProfiles: ApiProfile[];
    /** 'custom'＝未存档表单值，否则＝配置档 id。 */
    activeApiProfileId: string;
}

/** 编辑现场暂存（需求框/结果框；refine 的目标缓冲区即 result）。 */
export interface UserContext {
    request: string;
    result: string;
    hasResult: boolean;
}

/** persona 全局域形状。 */
export interface PersonaDomain {
    localConfig: LocalConfig;
    /** 世界书勾选缓存 {charKey: {bookName: [uid字符串]}}。 */
    wiSelection: Record<string, Record<string, string[]>>;
    uiState: { generationPreset: string };
    userContext: UserContext;
    /** 钉选常驻书（所有角色卡自动加载）。 */
    pinnedBooks: string[];
}

export function defaultUserContext(): UserContext {
    return { request: '', result: '', hasResult: false };
}

export function defaultLocalConfig(): LocalConfig {
    return {
        apiSource: 'main',
        indepApiUrl: 'https://api.openai.com/v1',
        indepApiKey: '',
        indepApiModel: 'gpt-3.5-turbo',
        indepTimeout: 300,
        indepStream: true,
        thinkingEffort: 'off',
        extraBooks: [],
        apiProfiles: [],
        activeApiProfileId: 'custom',
    };
}

export function defaultPersonaDomain(): PersonaDomain {
    return {
        localConfig: defaultLocalConfig(),
        wiSelection: {},
        uiState: { generationPreset: 'current' },
        userContext: defaultUserContext(),
        pinnedBooks: [],
    };
}

// ============================================================================
// normalize（域形状保真：未知字段丢弃，缺字段补默认）
// ============================================================================

const THINKING_EFFORTS: readonly string[] = ['off', 'low', 'medium', 'high'];
const API_SOURCES: readonly string[] = ['main', 'independent'];

/** 超时钳制（旧 clampTimeout 同语义：30..1800 秒）。 */
export function clampTimeout(sec: number): number {
    return Math.min(1800, Math.max(30, sec));
}

function normalizeString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

function normalizeStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function normalizeProfiles(value: unknown): ApiProfile[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const raw = item as Record<string, unknown>;
        const id = typeof raw.id === 'string' ? raw.id : '';
        // id 为空＝坏档（旧档 id 是 Date.now().toString()，恒非空）
        if (!id) return [];
        return [{
            id,
            name: normalizeString(raw.name, '未命名配置'),
            url: normalizeString(raw.url, ''),
            key: normalizeString(raw.key, ''),
            model: normalizeString(raw.model, ''),
        }];
    });
}

function normalizeLocalConfig(value: unknown): LocalConfig {
    const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const defaults = defaultLocalConfig();
    const timeout = Number(raw.indepTimeout);
    const effort = normalizeString(raw.thinkingEffort, 'off');
    const source = normalizeString(raw.apiSource, 'main');
    return {
        apiSource: (API_SOURCES.includes(source) ? source : 'main') as ApiSource,
        indepApiUrl: normalizeString(raw.indepApiUrl, defaults.indepApiUrl),
        indepApiKey: normalizeString(raw.indepApiKey, ''),
        indepApiModel: normalizeString(raw.indepApiModel, defaults.indepApiModel),
        indepTimeout: clampTimeout(Number.isFinite(timeout) && timeout > 0 ? timeout : defaults.indepTimeout),
        indepStream: typeof raw.indepStream === 'boolean' ? raw.indepStream : defaults.indepStream,
        thinkingEffort: (THINKING_EFFORTS.includes(effort) ? effort : 'off') as ThinkingEffort,
        extraBooks: normalizeStringArray(raw.extraBooks),
        apiProfiles: normalizeProfiles(raw.apiProfiles),
        activeApiProfileId: normalizeString(raw.activeApiProfileId, 'custom'),
    };
}

function normalizeWiSelection(value: unknown): Record<string, Record<string, string[]>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, Record<string, string[]>> = {};
    for (const [charKey, books] of Object.entries(value as Record<string, unknown>)) {
        if (!books || typeof books !== 'object' || Array.isArray(books)) continue;
        const bookMap: Record<string, string[]> = {};
        for (const [bookName, uids] of Object.entries(books as Record<string, unknown>)) {
            // uid 归一为字符串（勾选比对口径是 String(e.uid)）
            const list = Array.isArray(uids) ? uids.filter((u): u is string => typeof u === 'string') : [];
            bookMap[bookName] = list;
        }
        out[charKey] = bookMap;
    }
    return out;
}

function normalizeUserContext(value: unknown): UserContext {
    // 逐字段重建：旧形状的 template/curatedSchema 字段丢弃（已淘汰）
    const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    return {
        request: normalizeString(raw.request, ''),
        result: normalizeString(raw.result, ''),
        hasResult: raw.hasResult === true,
    };
}

/** 域 normalize（未知字段丢弃：本域无任何透传字段，新增字段须显式声明）。 */
export function normalizePersonaDomain(value: unknown): PersonaDomain {
    const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const uiStateRaw = (raw.uiState && typeof raw.uiState === 'object' ? raw.uiState : {}) as Record<string, unknown>;
    return {
        localConfig: normalizeLocalConfig(raw.localConfig),
        wiSelection: normalizeWiSelection(raw.wiSelection),
        // 旧 uiStateCache 淘汰字段（templateExpanded/avatarRef/generationMode/
        // chatHistory/theme）在 normalize 的未知字段丢弃面自然出局
        uiState: { generationPreset: normalizeString(uiStateRaw.generationPreset, 'current') },
        userContext: normalizeUserContext(raw.userContext),
        pinnedBooks: normalizeStringArray(raw.pinnedBooks),
    };
}

// ============================================================================
// 域读写（读-改-写单通道，照 choice/api.ts 纪律）
// ============================================================================

export function readPersonaDomain(): PersonaDomain {
    return normalizePersonaDomain(getGlobal(PERSONA_DOMAIN_KEY));
}

export function writePersonaDomain(mutate: (domain: PersonaDomain) => void): PersonaDomain {
    const domain = readPersonaDomain();
    mutate(domain);
    const normalized = normalizePersonaDomain(domain);
    setGlobal(PERSONA_DOMAIN_KEY, normalized);
    return normalized;
}

// ============================================================================
// 旧 localStorage 迁移（幂等；node 冒烟环境 localStorage 是 Map 存根）
// ============================================================================

function readLegacyJson(key: string): Record<string, unknown> {
    try {
        const raw = globalThis.localStorage?.getItem(key);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** 迁移报告（smoke 断言二次启动零重写用：migrated=false 即无写）。 */
export interface PersonaMigrationReport {
    /** 域已存在（本次未搬任何旧键、未写域）。 */
    skipped: boolean;
    /** 迁移来源键（实际读到数据的键名）。 */
    migratedKeys: string[];
    /** 本次 removeItem 的退休键。 */
    retiredKeysCleaned: string[];
}

/**
 * 幂等迁移：域缺席时搬 5 旧键（含 apiProfiles 收档迁移）+清退休键；
 * 域在场时只清退休键（retired removeItem 本身幂等且零域写）。
 * 旧键保留作 legacy 快照（防回滚旧版本丢存量），此后只读不写。
 */
export function migratePersonaDomain(): PersonaMigrationReport {
    const report: PersonaMigrationReport = { skipped: false, migratedKeys: [], retiredKeysCleaned: [] };

    // 退休键清理无条件执行（幂等，与域是否在场无关）
    for (const key of RETIRED_KEYS) {
        try {
            if (globalThis.localStorage?.getItem(key) !== null) {
                globalThis.localStorage?.removeItem(key);
                report.retiredKeysCleaned.push(key);
            }
        } catch {
            // localStorage 不可用（node 无存根形态）＝无存量可清
        }
    }

    const existing = getGlobal(PERSONA_DOMAIN_KEY);
    if (existing !== undefined) {
        report.skipped = true;
        return report;
    }

    // ---- 读 5 旧键（只搬实际读到数据的键，报告来源） ----
    const savedState = readLegacyJson(LEGACY_KEYS.state);
    const legacyLocalConfigRaw = savedState.localConfig;
    const localConfig = normalizeLocalConfig(legacyLocalConfigRaw);
    if (Object.keys(savedState).length > 0) report.migratedKeys.push(LEGACY_KEYS.state);

    // apiProfiles 收档迁移（旧 migrateApiProfiles 同语义，幂等）：旧档无
    // apiProfiles 时把独立 API 现值收成「默认配置 1」档并选中
    if (legacyLocalConfigRaw !== undefined && !Array.isArray((legacyLocalConfigRaw as Record<string, unknown>).apiProfiles)) {
        const existingUrl = localConfig.indepApiUrl || defaultLocalConfig().indepApiUrl;
        if (existingUrl) {
            localConfig.apiProfiles = [{
                id: `legacy-${Date.now().toString()}`,
                name: '默认配置 1',
                url: existingUrl,
                key: localConfig.indepApiKey || '',
                model: localConfig.indepApiModel || '',
            }];
            localConfig.activeApiProfileId = localConfig.apiProfiles[0].id;
        }
    }

    const wiSelection = normalizeWiSelection(readLegacyJson(LEGACY_KEYS.wiSelection));
    if (Object.keys(wiSelection).length > 0) report.migratedKeys.push(LEGACY_KEYS.wiSelection);

    const uiStateRaw = readLegacyJson(LEGACY_KEYS.uiState);
    const uiState = { generationPreset: normalizeString(uiStateRaw.generationPreset, 'current') };
    if (Object.keys(uiStateRaw).length > 0) report.migratedKeys.push(LEGACY_KEYS.uiState);

    const dataUserRaw = readLegacyJson(LEGACY_KEYS.dataUser);
    const userContext = normalizeUserContext(dataUserRaw);
    if (Object.keys(dataUserRaw).length > 0) report.migratedKeys.push(LEGACY_KEYS.dataUser);

    // pw_pinned_books_v1 形状＝裸 JSON 数组（旧 world-info.js:18 顶层装载实证）
    let pinnedBooks: string[] = [];
    try {
        const raw = globalThis.localStorage?.getItem(LEGACY_KEYS.pinnedBooks);
        if (raw) {
            const parsed = JSON.parse(raw) as unknown;
            pinnedBooks = Array.isArray(parsed) ? normalizeStringArray(parsed) : [];
        }
    } catch {
        pinnedBooks = [];
    }
    if (pinnedBooks.length > 0) report.migratedKeys.push(LEGACY_KEYS.pinnedBooks);

    setGlobal(PERSONA_DOMAIN_KEY, normalizePersonaDomain({
        localConfig,
        wiSelection,
        uiState,
        userContext,
        pinnedBooks,
    }));
    return report;
}

// ============================================================================
// 世界书勾选缓存（读写走域，charKey 兜底语义见 generation.ts）
// ============================================================================

/** 读当前 charKey 的勾选（无记录返回 null＝走 enabled 全选默认）。 */
export function loadWiSelectionFor(charKey: string, bookName: string): string[] | null {
    const books = readPersonaDomain().wiSelection[charKey];
    const uids = books?.[bookName];
    return Array.isArray(uids) ? uids : null;
}

/** 写当前 charKey 的勾选（写域单通道）。 */
export function saveWiSelectionFor(charKey: string, bookName: string, uids: string[]): void {
    writePersonaDomain(domain => {
        domain.wiSelection[charKey] ??= {};
        domain.wiSelection[charKey][bookName] = uids;
    });
}
