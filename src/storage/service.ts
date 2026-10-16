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
 * 唯一例外：无服务原语的历史遗留操作（如退役域键的 delete——写口是整键
 * 替换做不了删除）走 host 层直访，见 retire-summary.ts 的通道说明。
 */

import { currentChatMetadata, extension_settings, writeChatMetadata, writeExtensionSettings } from '@/host';
import type { StoryDirection } from '@/prompts/types';
import { isRecord } from './shape';

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
 * 全局域显式键登记：每个功能子域一个键，域键常量与域类型都住在归属模块，
 * 登记面经声明合并（`declare module '@/storage/service'` 补本接口）由各子域
 * 自己声明——服务层因此不必反向 import 任何功能模块（那会让 storage↔modules
 * 成环，而域读写是全仓最底层的公共面）。
 *
 * 本接口内联的键只有两类，判据是「类型定义处是否依赖 storage」：类型就在本
 * 文件（nav：启动期迁移由本层执行）或定义在零依赖叶子模块（storyDirection：
 * prompts/types）。其余子域一律走声明合并。
 *
 * 新增键漏登记的代价在编译期：getGlobal/setGlobal 的键收窄到 keyof，子域
 * 写新键而不登记，vue-tsc 立即报错（编译期登记门）。
 */
export interface GlobalDomain {
    nav: NavStorageState;
    /**
     * 旧 localStorage 遗留键一次性清理标记（v1.0.0 起，见 legacy-wipe）：
     * true＝清理已执行过，启动整段跳过。缺省（旧档）视为 false。
     */
    legacyWipeDone?: boolean;
}

/** 聊天域显式键登记（登记义务同 GlobalDomain）。 */
export interface ChatDomain {
    /** 剧情走向（modules/choice/direction.ts CHAT_STORY_DIRECTION_KEY） */
    storyDirection?: StoryDirection;
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
 *
 * 返回类型由键派生（不再由调用方自称）——自称类型正是登记门失效的根因：
 * 键名对了、值类型随便编，编译器无从发现「这键存的不是这个形状」。
 *
 * 类型描述的是该键的**规范形状**，不是存档里必然已有的形状：域值来自
 * 历史存档与外部手改，读面仍须经归属模块的 normalize 才可安全展开
 * （坏档容忍不因类型收紧而消失，收紧只发生在 API 面）。
 */
export function getGlobal<K extends keyof GlobalDomain>(key: K): GlobalDomain[K] | undefined {
    const domain = readGlobalDomain();
    return deepSnapshot(domain[key]) as GlobalDomain[K] | undefined;
}

/**
 * 写全局域子域：整体替换该 key 下的对象并调度落盘。值类型同样由键派生
 * （写侧与读侧同一份形状定义，两边不各写一套）。
 */
export function setGlobal<K extends keyof GlobalDomain>(key: K, value: GlobalDomain[K]): void {
    writeExtensionSettings(settings => {
        const domain = (isRecord(settings[GLOBAL_KEY]) ? settings[GLOBAL_KEY] : {}) as Record<K, GlobalDomain[K]>;
        domain[key] = value;
        settings[GLOBAL_KEY] = domain;
    });
}

/** 读聊天域子域（真深快照：返回值与存储单例解耦，写入走 setChat；口径同 getGlobal）。 */
export function getChat<K extends keyof ChatDomain>(key: K): ChatDomain[K] | undefined {
    const domain = readChatDomain();
    return deepSnapshot(domain[key]) as ChatDomain[K] | undefined;
}

/** 写聊天域子域：整体替换该 key，经 host 层立即显式保存（口径同 setGlobal）。 */
export function setChat<K extends keyof ChatDomain>(key: K, value: ChatDomain[K]): void {
    writeChatMetadata(metadata => {
        const domain = (isRecord(metadata[CHAT_KEY]) ? metadata[CHAT_KEY] : {}) as Record<K, ChatDomain[K]>;
        domain[key] = value;
        metadata[CHAT_KEY] = domain;
    });
}
