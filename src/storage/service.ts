/**
 * 统一设置存储（三域一层服务）。
 *
 * 域划分：
 *   - 全局域 extension_settings.ttToolkit：提示词配置集、条目池、API 配置、
 *     UI 偏好、nav 迁移数据。各内容子域自带版本机制
 *     （如 choice 域 assetVersion），顶层不再持 schema version 概念。
 *   - 聊天域 chat_metadata.ttToolkit：配置绑定、剧情走向设置。
 *     写入纪律：同步变更当前 chat_metadata + 立即 getContext().saveMetadata
 *     显式保存（host/settings.ts，无防抖无排队、目标即当前活跃聊天）。
 *   - 角色域 character.data.extensions.ttToolkit：预留域，本仓暂无写面；
 *     若落地配置绑定须经 /api/characters/edit 全量合并通道（契约按 TT
 *     源码核实，严禁 saveCharacterDebounced）。
 *
 * 组件与模块一律通过本服务读写，不直接碰 extension_settings/chat_metadata。
 */

import { currentChatMetadata, eventBus, event_types, extension_settings, writeChatMetadata, writeExtensionSettings } from '@/host';

/** 全局域存储键（extension_settings 下本扩展命名空间）。 */
export const GLOBAL_KEY = 'ttToolkit';
/** 聊天域存储键（chat_metadata 下本扩展命名空间）。 */
export const CHAT_KEY = 'ttToolkit';

/**
 * 旧 nav localStorage 键（迁移源；键名单一真相源在此，legacy-wipe 的
 * 清理清单从这里导出——禁在别处另写第二份字面量）。
 */
export const LEGACY_NAV_AUTO_TOP_KEY = 'tt_msg_nav_auto_top';
export const LEGACY_NAV_QR_ACTIVATED_KEY = 'tt_nav_qr_activated';

export interface NavStorageState {
    /** QR 集「首次激活」标记（激活一次制，见 nav 模块） */
    qrActivated: boolean;
    /** 历史版本「自动回顶」QR 键的一次性清理标记（见 nav 模块 qr 接线） */
    legacyQrCleaned?: boolean;
}

/**
 * 全局域显式键登记：每个功能子域一个键，域键常量在归属模块定义
 * （字面量仅此一份），登记与此处互为表里——新增键不补进本 union，
 * getGlobal/setGlobal 的 keyof 门在 vue-tsc 阶段报错（编译期登记门）。
 */
export interface GlobalDomain {
    nav: NavStorageState;
    /** choice 域（生成参数＋条目池；modules/choice/api.ts GLOBAL_CHOICE_KEY） */
    choice?: unknown;
    /** 统一端点表（modules/apis/storage.ts APIS_DOMAIN_KEY） */
    apis?: unknown;
    /** 全局活动端点（引用统一端点表条目 id；''/缺席/指向已删端点＝未选态）。 */
    activeEndpointId?: string;
    /** 破限预设名（modules/apis/storage.ts JAILBREAK_PRESET_KEY） */
    jailbreakPreset?: unknown;
    /** persona 域（modules/persona/storage.ts PERSONA_DOMAIN_KEY） */
    persona?: unknown;
    /** 提示词配置集（prompts/storage.ts GLOBAL_PROMPT_CONFIGS_KEY） */
    promptConfigs?: unknown;
    /** legacy：旧 promptConfigs 数组形态的活跃键（只读迁移残留，读侧出局后自然消失） */
    promptActiveId?: unknown;
    /** 剧情走向预设列表（modules/choice/direction.ts GLOBAL_DIRECTION_PRESETS_KEY） */
    directionPresets?: unknown;
    /** 大小总结设置（modules/summary/settings.ts GLOBAL_SUMMARY_KEY） */
    summary?: unknown;
    /**
     * 旧 localStorage 遗留键一次性清理标记（v1.0.0 起，见 legacy-wipe）：
     * true＝清理已执行过，启动整段跳过。缺省（旧档）视为 false。
     */
    legacyWipeDone?: boolean;
}

/** 聊天域显式键登记（登记义务同 GlobalDomain）。 */
export interface ChatDomain {
    /** 剧情走向（modules/choice/direction.ts CHAT_STORY_DIRECTION_KEY） */
    storyDirection?: unknown;
    /** 大小总结聊天态（modules/summary/settings.ts CHAT_SUMMARY_KEY） */
    summary?: unknown;
}

/** 读全局域原始单例（不快照——storage 内部面与调试 dump 用）。 */
export function readGlobalDomain(): GlobalDomain {
    const raw = extension_settings[GLOBAL_KEY];
    return (raw ?? {}) as GlobalDomain;
}

/** 读聊天域原始单例（不快照——storage 内部面与调试 dump 用）。 */
export function readChatDomain(): ChatDomain {
    const raw = currentChatMetadata()[CHAT_KEY];
    return (raw ?? {}) as ChatDomain;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 深快照：读取返回值与宿主可变单例彻底解耦——调用方改返回值不会
 * 污染 extension_settings / chat_metadata。设置域为小对象非热路径，
 * 正确性优先；structuredClone 缺席（宿主环境裁剪）时降级浅拷贝。
 */
function deepSnapshot<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    try {
        return structuredClone(value);
    } catch {
        return Array.isArray(value) ? ([...value] as T) : ({ ...(value as object) } as T);
    }
}

/**
 * 初始化全局域：确保命名空间与结构在场、迁移旧 nav localStorage 键、
 * 丢弃 nav 域存量退役字段（autoTop 开关已固化恒开——delete 缺席键幂等，
 * 与 persona 域收缩同款「退役字段丢弃」纪律）。幂等——每次启动跑一遍。
 */
export function initStorage(): void {
    writeExtensionSettings(settings => {
        const domain = (isRecord(settings[GLOBAL_KEY]) ? settings[GLOBAL_KEY] : {}) as unknown as GlobalDomain;

        // nav 域迁移：storage 值缺省时从旧 localStorage 键搬（旧键保留）
        const nav = (isRecord(domain.nav) ? domain.nav : {}) as Partial<NavStorageState> & Record<string, unknown>;
        if (typeof nav.qrActivated !== 'boolean') {
            nav.qrActivated = readLegacyBoolean(LEGACY_NAV_QR_ACTIVATED_KEY, false);
        }
        delete nav.autoTop;
        delete nav.legacyAutoTopSnapshot;
        domain.nav = nav as NavStorageState;
        settings[GLOBAL_KEY] = domain;
    });
}

function readLegacyBoolean(key: string, fallback: boolean): boolean {
    try {
        const v = localStorage.getItem(key);
        if (v === '1') return true;
        if (v === '0') return false;
    } catch {
        // localStorage 不可用（隐私模式等）：视为旧键缺席
    }
    return fallback;
}

/**
 * 读全局域子域（真深快照：返回值与存储单例解耦，写入走 setGlobal）。
 * key 收窄到显式键 union＝编译期登记门（见 GlobalDomain 注）。
 */
export function getGlobal<T>(key: keyof GlobalDomain): T | undefined {
    const domain = readGlobalDomain();
    return deepSnapshot(domain[key]) as T | undefined;
}

/** 写全局域子域：整体替换该 key 下的对象并调度落盘。 */
export function setGlobal(key: keyof GlobalDomain, value: unknown): void {
    writeExtensionSettings(settings => {
        // 写视图＝键登记表（值 unknown：值形状由归属模块的 normalize 守门）
        const domain = (isRecord(settings[GLOBAL_KEY]) ? settings[GLOBAL_KEY] : {}) as Record<keyof GlobalDomain, unknown>;
        domain[key] = value;
        settings[GLOBAL_KEY] = domain;
    });
}

/** 读聊天域子域（真深快照：返回值与存储单例解耦，写入走 setChat）。 */
export function getChat<T>(key: keyof ChatDomain): T | undefined {
    const domain = readChatDomain();
    return deepSnapshot(domain[key]) as T | undefined;
}

/** 写聊天域子域：整体替换该 key，经 host 层立即显式保存。 */
export function setChat(key: keyof ChatDomain, value: unknown): void {
    writeChatMetadata(metadata => {
        const domain = (isRecord(metadata[CHAT_KEY]) ? metadata[CHAT_KEY] : {}) as Record<keyof ChatDomain, unknown>;
        domain[key] = value;
        metadata[CHAT_KEY] = domain;
    });
}

/** 订阅聊天切换（storage 消费方需要丢弃聊天相关缓存时用）。 */
export function onChatChanged(handler: () => void): void {
    eventBus.on(event_types.CHAT_CHANGED, handler);
}
