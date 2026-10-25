/**
 * storage 服务导出面：统一持久化的唯一入口。
 * 组件/模块禁止直接 import host 层的 settings 单例做读写。
 */

export {
    CHAT_KEY,
    GLOBAL_KEY,
    getChat,
    getGlobal,
    initStorage,
    setChat,
    setGlobal,
} from './service';
export type { ChatDomain, GlobalDomain, NavStorageState } from './service';
export { newId } from './id';
// legacy-wipe 的 smoke 半不经桶（见 legacy-wipe.ts 头注：smoke 名经桶即
// 回流入口静态图，发布件分块失效）
export { LEGACY_WIPE_KEYS, wipeLegacyKeysOnce } from './legacy-wipe';
export type { LegacyWipeReport } from './legacy-wipe';
