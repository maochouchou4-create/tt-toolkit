/**
 * storage 服务导出面：统一持久化的唯一入口。
 * 组件/模块禁止直接 import host 层的 settings 单例做读写。
 */

export {
    CHAT_KEY,
    GLOBAL_KEY,
    dumpStorage,
    getChat,
    getGlobal,
    getNavState,
    initStorage,
    onChatChanged,
    runStorageRoundtrip,
    setChat,
    setGlobal,
    setNavState,
} from './service';
export type { ChatDomain, GlobalDomain, NavStorageState, RoundtripReport } from './service';
