/**
 * persona 存储域与旧 localStorage 迁移。
 *
 * 数据落点：extension_settings.ttToolkit.persona 全局域（经 storage 层
 * getGlobal/setGlobal 单通道）。域形状 normalize 纪律照 choice/pool：
 * 未知字段丢弃（显式保真注释），缺字段补默认，反复读写幂等。
 *
 * 整合轮II：端点身份（url/key/model）移入统一端点表（modules/apis），
 * localConfig 只保留 persona 任务参数＋选中端点引用 endpointId。旧字段
 * （apiSource、indepApi 前缀三键、apiProfiles、activeApiProfileId）由 migrateApiDomain
 * 一次性收编，此后在 normalize 的未知字段丢弃面自然退休。
 *
 * 迁移纪律（nav 同款幂等）：域不存在→读 5 个旧键搬入新域→保留旧键
 * 作 legacy 快照（回滚旧版本不丢存量；新版本不再写旧键）→退休键
 * removeItem；域已存在→跳过迁移（二次启动零重写）。
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

/** persona 任务配置（localConfig v2：端点引用＋任务参数，无端点身份）。 */
export interface LocalConfig {
    /** 选中统一端点表条目 id（空＝未配置端点）。 */
    endpointId: string;
    /** 流式请求（长请求防挂死姿势；旧 indepStream）。 */
    stream: boolean;
    thinkingEffort: ThinkingEffort;
    /** 请求超时秒数（钳制 30..1800；旧 indepTimeout）。 */
    timeoutSec: number;
    /** 追加参考世界书（钉选+本会话手动添加）。 */
    extraBooks: string[];
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
        endpointId: '',
        stream: true,
        thinkingEffort: 'off',
        timeoutSec: 300,
        extraBooks: [],
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

function normalizeLocalConfig(value: unknown): LocalConfig {
    const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const timeout = Number(raw.timeoutSec);
    const effort = normalizeString(raw.thinkingEffort, 'off');
    return {
        endpointId: normalizeString(raw.endpointId, ''),
        stream: typeof raw.stream === 'boolean' ? raw.stream : true,
        thinkingEffort: (THINKING_EFFORTS.includes(effort) ? effort : 'off') as ThinkingEffort,
        timeoutSec: clampTimeout(Number.isFinite(timeout) && timeout > 0 ? timeout : 300),
        extraBooks: normalizeStringArray(raw.extraBooks),
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

/** 迁移报告（smoke 断言二次启动零重写用：skipped=true 即无域写）。 */
export interface PersonaMigrationReport {
    /** 域已存在（本次未搬任何旧键、未写域）。 */
    skipped: boolean;
    /** 迁移来源键（实际读到数据的键名）。 */
    migratedKeys: string[];
    /** 本次 removeItem 的退休键。 */
    retiredKeysCleaned: string[];
}

/** 旧 localConfig 中的端点身份字段（migrateApiDomain 的收编原料）。 */
const LEGACY_ENDPOINT_FIELDS = [
    'apiSource',
    'indepApiUrl',
    'indepApiKey',
    'indepApiModel',
    'apiProfiles',
    'activeApiProfileId',
] as const;

/**
 * 幂等迁移：域缺席时搬 5 旧键＋清退休键；域在场时只清退休键。
 * 旧键保留作 legacy 快照（防回滚旧版本丢存量），此后只读不写。
 *
 * 旧 localConfig 的 v2 字段（stream/thinkingEffort/timeoutSec）就地转正；
 * 端点身份旧字段（apiProfiles/indepApi* 等）以过渡形状透传进域，由同一次
 * 启动里的 migrateApiDomain（modules/apis/migration.ts）收编进统一端点表。
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
    if (Object.keys(savedState).length > 0) report.migratedKeys.push(LEGACY_KEYS.state);

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

    // v2 字段就地转正：旧键名（indepStream/indepTimeout）先归位到 v2 键名
    // 再 normalize——normalize 只认 v2 形状，且这两个键不在端点透传清单里，
    // 不先映射用户的流式/超时设置会被丢弃面吞掉
    const legacyLocal = (legacyLocalConfigRaw && typeof legacyLocalConfigRaw === 'object'
        ? legacyLocalConfigRaw
        : {}) as Record<string, unknown>;
    const legacyFieldPatch: Record<string, unknown> = {};
    if (legacyLocal.stream === undefined && typeof legacyLocal.indepStream === 'boolean') {
        legacyFieldPatch.stream = legacyLocal.indepStream;
    }
    const legacyTimeout = Number(legacyLocal.indepTimeout);
    if (legacyLocal.timeoutSec === undefined && Number.isFinite(legacyTimeout) && legacyTimeout > 0) {
        legacyFieldPatch.timeoutSec = legacyTimeout;
    }
    const localConfig = normalizeLocalConfig({ ...legacyLocal, ...legacyFieldPatch });
    const domain = normalizePersonaDomain({
        localConfig,
        wiSelection,
        uiState,
        userContext,
        pinnedBooks,
    });
    // 端点身份旧字段过渡透传（进域即脱离 localStorage，供 migrateApiDomain
    // 收编；收编完成后这些键在 normalize 丢弃面自然消失——所以这里必须在
    // normalize 之后回填，否则过渡字段会被丢弃面吞掉）
    for (const field of LEGACY_ENDPOINT_FIELDS) {
        if (legacyLocal[field] !== undefined) {
            (domain.localConfig as unknown as Record<string, unknown>)[field] = legacyLocal[field];
        }
    }
    setGlobal(PERSONA_DOMAIN_KEY, domain);
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
