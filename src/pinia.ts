/**
 * 共享 Pinia 实例：壳与各 tab 的子 app 复用同一实例（一个扩展一个
 * pinia，store 状态跨 tab 共享——nav 设置 tab 与 nav 核心模块读写同一
 * 状态的前提）。
 */
import { createPinia, setActivePinia } from 'pinia';

export const pinia = createPinia();

// nav 等命令式模块在事件回调（无组件上下文）里调 useNavStore，
// 必须先激活实例，否则 Pinia 抛“no active Pinia”
setActivePinia(pinia);
