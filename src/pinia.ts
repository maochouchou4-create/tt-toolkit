/**
 * 共享 Pinia 实例：壳与各 tab 的子 app 复用同一实例（一个扩展一个
 * pinia）。实例与 setActivePinia 必须保留：runlog/apis 等命令式模块
 * 在事件回调（无组件上下文）里取 store，依赖 active 实例，否则
 * Pinia 抛“no active Pinia”。
 */
import { createPinia, setActivePinia } from 'pinia';

export const pinia = createPinia();

setActivePinia(pinia);
