/**
 * 统一设置存储（方案 §2.2 三域一层服务的批A 落地面）。
 *
 * 域划分：
 *   - 全局域 extension_settings.ttToolkit：提示词配置集、条目池、API 配置、
 *     UI 偏好、nav 迁移数据、schema version（批B/C 扩展内容域）。
 *   - 聊天域 chat_metadata.ttToolkit：配置绑定、剧情走向设置（批B 落）。
 *     写入纪律：同步变更当前 chat_metadata + 立即 getContext().saveMetadata
 *     显式保存（host/settings.ts，无防抖无排队、目标即当前活跃聊天）。
 *   - 角色域 character.data.extensions.ttToolkit：配置绑定，归批C（配置
 *     绑定功能落地时一并实现 /api/characters/edit 全量合并通道——该通道
 *     契约届时按 TT 源码核实，严禁 saveCharacterDebounced，方案 §2.2）。
 *
 * 组件与模块一律通过本服务读写，不直接碰 extension_settings/chat_metadata。
 */

import { chat_metadata, eventBus, event_types, extension_settings, writeChatMetadata, writeExtensionSettings } from '@/host';
import { newId } from './id';

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

// schema version：存储结构演进时 bump；旧档缺字段由默认值补齐
const SCHEMA_VERSION = 2;

export interface NavStorageState {
    /** 自动回顶开关（旧 localStorage 键迁移而来） */
    autoTop: boolean;
    /** QR 集「首次激活」标记（激活一次制，见 nav 模块） */
    qrActivated: boolean;
    /**
     * 迁移时旧键 autoTop 值的快照（幂等增量基线）；null＝旧键缺席。
     * 后续启动旧键值偏离快照＝用户回滚旧版期间改过，采纳为新意图。
     */
    legacyAutoTopSnapshot?: boolean | null;
}

export interface GlobalDomain {
    schemaVersion: number;
    nav: NavStorageState;
    /**
     * 旧 localStorage 遗留键一次性清理标记（批E/v1.0.0，见 legacy-wipe）：
     * true＝清理已执行过，启动整段跳过。缺省（旧档）视为 false。
     */
    legacyWipeDone?: boolean;
    [key: string]: unknown;
}

export interface ChatDomain {
    [key: string]: unknown;
}

function readGlobalDomain(): GlobalDomain {
    const raw = extension_settings[GLOBAL_KEY];
    return (raw ?? {}) as GlobalDomain;
}

function readChatDomain(): ChatDomain {
    const raw = chat_metadata[CHAT_KEY];
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
 * 初始化全局域：确保命名空间与结构在场、迁移旧 nav localStorage 键。
 * 幂等——每次启动跑一遍，storage 值已在场时不覆盖；旧键幂等增量：
 * 记录迁移时的旧键值快照，后续启动旧键值偏离快照（＝用户回滚旧版
 * 期间改过）即采纳为新意图并前移快照——防「回滚旧版用一段再升回、
 * 增量静默丢失」（persona 迁移同款纪律，单布尔低配版）。
 */
export function initStorage(): void {
    writeExtensionSettings(settings => {
        const domain = (isRecord(settings[GLOBAL_KEY]) ? settings[GLOBAL_KEY] : {}) as GlobalDomain;
        if (typeof domain.schemaVersion !== 'number') domain.schemaVersion = SCHEMA_VERSION;

        // nav 域迁移：storage 值缺省时从旧 localStorage 键搬（旧键保留）
        const nav = (isRecord(domain.nav) ? domain.nav : {}) as Partial<NavStorageState>;
        if (typeof nav.autoTop !== 'boolean') {
            nav.autoTop = readLegacyBoolean(LEGACY_NAV_AUTO_TOP_KEY, true);
        }
        if (typeof nav.qrActivated !== 'boolean') {
            nav.qrActivated = readLegacyBoolean(LEGACY_NAV_QR_ACTIVATED_KEY, false);
        }
        if (nav.legacyAutoTopSnapshot === undefined) {
            // 首次迁移或旧 schema 升级：以当前旧键值为基线快照（不采纳
            // ——此时无法区分「用户改过」与「本来就如此」）
            nav.legacyAutoTopSnapshot = readLegacyBooleanOrNull(LEGACY_NAV_AUTO_TOP_KEY);
        }
        const legacyAutoTopNow = readLegacyBooleanOrNull(LEGACY_NAV_AUTO_TOP_KEY);
        if (legacyAutoTopNow !== null && legacyAutoTopNow !== nav.legacyAutoTopSnapshot) {
            // 旧键偏离基线＝回滚旧版期间用户改过，采纳为新意图
            nav.autoTop = legacyAutoTopNow;
            nav.legacyAutoTopSnapshot = legacyAutoTopNow;
        }
        domain.nav = nav as NavStorageState;
        settings[GLOBAL_KEY] = domain;
    });
}

function readLegacyBooleanOrNull(key: string): boolean | null {
    try {
        const v = localStorage.getItem(key);
        if (v === '1') return true;
        if (v === '0') return false;
    } catch {
        // localStorage 不可用（隐私模式等）：视为旧键缺席
    }
    return null;
}

function readLegacyBoolean(key: string, fallback: boolean): boolean {
    return readLegacyBooleanOrNull(key) ?? fallback;
}

/** 读全局域子域（真深快照：返回值与存储单例解耦，写入走 setGlobal）。 */
export function getGlobal<T>(key: string): T | undefined {
    const domain = readGlobalDomain();
    return deepSnapshot(domain[key]) as T | undefined;
}

/** 写全局域子域：整体替换该 key 下的对象并调度落盘。 */
export function setGlobal(key: string, value: unknown): void {
    writeExtensionSettings(settings => {
        const domain = (isRecord(settings[GLOBAL_KEY]) ? settings[GLOBAL_KEY] : {}) as GlobalDomain;
        domain[key] = value;
        settings[GLOBAL_KEY] = domain;
    });
}

/** 读聊天域子域（真深快照：返回值与存储单例解耦，写入走 setChat）。 */
export function getChat<T>(key: string): T | undefined {
    const domain = readChatDomain();
    return deepSnapshot(domain[key]) as T | undefined;
}

/** 写聊天域子域：整体替换该 key，经 host 层立即显式保存。 */
export function setChat(key: string, value: unknown): void {
    writeChatMetadata(metadata => {
        const domain = (isRecord(metadata[CHAT_KEY]) ? metadata[CHAT_KEY] : {}) as ChatDomain;
        domain[key] = value;
        metadata[CHAT_KEY] = domain;
    });
}

/** nav 域便捷读取（深快照；写入走 setNavState）。 */
export function getNavState(): NavStorageState {
    const nav = readGlobalDomain().nav;
    if (!isRecord(nav)) return { autoTop: true, qrActivated: false, legacyAutoTopSnapshot: null };
    return deepSnapshot(nav as unknown as NavStorageState);
}

export function setNavState(patch: Partial<NavStorageState>): void {
    const nav = { ...getNavState(), ...patch };
    setGlobal('nav', nav);
}

/** 订阅聊天切换（storage 消费方需要丢弃聊天相关缓存时用）。 */
export function onChatChanged(handler: () => void): void {
    eventBus.on(event_types.CHAT_CHANGED, handler);
}

// ---------------------------------------------------------------------------
// 烟雾 roundtrip（批A 判据机判：写读回显）
// ---------------------------------------------------------------------------

export interface RoundtripReport {
    scope: 'global' | 'chat';
    ok: boolean;
    written: string;
    readBack: string;
    at: string;
}

const SMOKE_KEY = '_smoke';

/**
 * storage 写读 roundtrip：全局域与聊天域各写一个随机 token 再读回比对。
 * 读回走同一读取路径（getGlobal/getChat），链路＝用户实际数据链路。
 * 比对完成后经正式变更器删除 _smoke 键——测试残留会随用户数据落盘
 * 并出现在调试 dump 里。
 */
export function runStorageRoundtrip(): RoundtripReport[] {
    const reports: RoundtripReport[] = [];

    const globalToken = newId('rt');
    setGlobal(SMOKE_KEY, { token: globalToken });
    const globalRead = getGlobal<{ token: string }>(SMOKE_KEY)?.token;
    reports.push({
        scope: 'global',
        ok: globalRead === globalToken,
        written: globalToken,
        readBack: String(globalRead),
        at: new Date().toISOString(),
    });

    const chatToken = newId('rt');
    setChat(SMOKE_KEY, { token: chatToken });
    const chatRead = getChat<{ token: string }>(SMOKE_KEY)?.token;
    reports.push({
        scope: 'chat',
        ok: chatRead === chatToken,
        written: chatToken,
        readBack: String(chatRead),
        at: new Date().toISOString(),
    });

    writeExtensionSettings(settings => {
        const domain = settings[GLOBAL_KEY];
        if (isRecord(domain)) delete domain[SMOKE_KEY];
    });
    writeChatMetadata(metadata => {
        const domain = metadata[CHAT_KEY];
        if (isRecord(domain)) delete domain[SMOKE_KEY];
    });

    return reports;
}

/**
 * 存储三域快照序列化（调试 dump 用；角色域批C 接入后并入）。
 * 密钥掩码（双复核 P3）：调试面板不回显明文——choice.apis[].key 只保留
 * 前 6 字符＋省略号（判断「填没填、填的是哪把」足够，整把钥匙不进 DOM）。
 */
export function dumpStorage(): string {
    const maskedGlobal = JSON.stringify(readGlobalDomain(), null, 2)
        ?.replace(/("key"\s*:\s*")([^"]*)(")/g, (_m, p1: string, val: string, p3: string) =>
            val ? `${p1}${val.slice(0, 6)}…${p3}` : `${p1}${val}${p3}`)
        ?? '';
    const lines = [
        `storage dump @ ${new Date().toISOString()}`,
        `global(${GLOBAL_KEY}) = ${maskedGlobal}`,
        `chat(${CHAT_KEY}) = ${JSON.stringify(readChatDomain(), null, 2)}`,
    ];
    return lines.join('\n');
}
