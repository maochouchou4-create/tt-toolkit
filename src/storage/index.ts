/**
 * storage 服务导出面：统一持久化的唯一入口。
 * 组件/模块禁止直接 import host 层的 settings 单例做读写。
 */

export {
    GLOBAL_KEY,
    getGlobal,
    initStorage,
    setGlobal,
} from './service';
export type { GlobalDomain, NavStorageState } from './service';
export { newId } from './id';
