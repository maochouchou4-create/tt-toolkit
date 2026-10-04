/**
 * 统一设置存储（方案 §2.2 三域一层服务的批A 落地面）。
 *
 * 域划分：
 *   - 全局域 extension_settings.ttToolkit：提示词配置集、条目池、API 配置、
 *     UI 偏好、nav 迁移数据、schema version（批B/C 扩展内容域）。
 *   - 聊天域 chat_metadata.ttToolkit：配置绑定、剧情走向设置（批B 落）。
 *     写入纪律：切换窗口内排队延后（host/settings.ts 的 quiet 窗口），
 *     防止 saveMetadataDebounced 在 characterId/groupId 变更窗口静默丢存。
 *   - 角色域 character.data.extensions.ttToolkit：配置绑定，归批C（配置
 *     绑定功能落地时一并实现 /api/characters/edit 全量合并通道——该通道
 *     契约届时按 TT 源码核实，严禁 saveCharacterDebounced，方案 §2.2）。
 *
 * 组件与模块一律通过本服务读写，不直接碰 extension_settings/chat_metadata。
 */

import { chat_metadata, eventBus, event_types, extension_settings, writeChatMetadata, writeExtensionSettings } from '@/host';

/** 全局域存储键（extension_settings 下本扩展命名空间）。 */
export const GLOBAL_KEY = 'ttToolkit';
/** 聊天域存储键（chat_metadata 下本扩展命名空间）。 */
export const CHAT_KEY = 'ttToolkit';

/** 旧 nav localStorage 键（迁移源，旧键保留只读，清理归批E）。 */
const LEGACY_NAV_AUTO_TOP_KEY = 'tt_msg_nav_auto_top';
const LEGACY_NAV_QR_ACTIVATED_KEY = 'tt_nav_qr_activated';

// schema version：存储结构演进时 bump；旧档缺字段由默认值补齐
const SCHEMA_VERSION = 1;

export interface NavStorageState {
    /** 自动回顶开关（旧 localStorage 键迁移而来） */
    autoTop: boolean;
    /** QR 集「首次激活」标记（激活一次制，见 nav 模块） */
    qrActivated: boolean;
}

export interface GlobalDomain {
    schemaVersion: number;
    nav: NavStorageState;
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
 * 初始化全局域：确保命名空间与结构在场、迁移旧 nav localStorage 键。
 * 幂等——每次启动跑一遍，storage 值已在场时不覆盖（防回滚旧版再升回时
 * 丢增量：旧版只写 localStorage，storage 已有值则尊重 storage）。
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
        // localStorage 不可用（隐私模式等）：落到默认值，仅影响迁移
    }
    return fallback;
}

/** 读全局域子域（浅快照，调用方不得原地改返回值——写入走 setGlobal）。 */
export function getGlobal<T>(key: string): T | undefined {
    const domain = readGlobalDomain();
    return domain[key] as T | undefined;
}

/** 写全局域子域：整体替换该 key 下的对象并调度落盘。 */
export function setGlobal(key: string, value: unknown): void {
    writeExtensionSettings(settings => {
        const domain = (isRecord(settings[GLOBAL_KEY]) ? settings[GLOBAL_KEY] : {}) as GlobalDomain;
        domain[key] = value;
        settings[GLOBAL_KEY] = domain;
    });
}

/** 读聊天域子域。 */
export function getChat<T>(key: string): T | undefined {
    const domain = readChatDomain();
    return domain[key] as T | undefined;
}

/** 写聊天域子域：整体替换该 key 并走切换感知的落盘调度。 */
export function setChat(key: string, value: unknown): void {
    writeChatMetadata(metadata => {
        const domain = (isRecord(metadata[CHAT_KEY]) ? metadata[CHAT_KEY] : {}) as ChatDomain;
        domain[key] = value;
        metadata[CHAT_KEY] = domain;
    });
}

/** nav 域便捷读写（高频小字段，避免各处拼对象）。 */
export function getNavState(): NavStorageState {
    const domain = readGlobalDomain();
    return domain.nav ?? { autoTop: true, qrActivated: false };
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

function randomToken(): string {
    return `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * storage 写读 roundtrip：全局域与聊天域各写一个随机 token 再读回比对。
 * 读回走同一读取路径（getGlobal/getChat），链路＝用户实际数据链路。
 */
export function runStorageRoundtrip(): RoundtripReport[] {
    const reports: RoundtripReport[] = [];

    const globalToken = randomToken();
    setGlobal(SMOKE_KEY, { token: globalToken });
    const globalRead = getGlobal<{ token: string }>(SMOKE_KEY)?.token;
    reports.push({
        scope: 'global',
        ok: globalRead === globalToken,
        written: globalToken,
        readBack: String(globalRead),
        at: new Date().toISOString(),
    });

    const chatToken = randomToken();
    setChat(SMOKE_KEY, { token: chatToken });
    const chatRead = getChat<{ token: string }>(SMOKE_KEY)?.token;
    reports.push({
        scope: 'chat',
        ok: chatRead === chatToken,
        written: chatToken,
        readBack: String(chatRead),
        at: new Date().toISOString(),
    });

    return reports;
}

/** 存储三域快照序列化（调试 dump 用；角色域批C 接入后并入）。 */
export function dumpStorage(): string {
    const lines = [
        `storage dump @ ${new Date().toISOString()}`,
        `global(${GLOBAL_KEY}) = ${JSON.stringify(readGlobalDomain(), null, 2)}`,
        `chat(${CHAT_KEY}) = ${JSON.stringify(readChatDomain(), null, 2)}`,
    ];
    return lines.join('\n');
}
