/**
 * 统一端点模块入口。
 *
 * initApis 只做域装载（pinia store 实例化）：服务商表与任务档案的读写全走
 * storage 层懒归一（读侧补默认/坏值钳制），无启动期写面——历史上的
 * 三步迁移机器（persona 域成型、统一端点收编、任务档案化）随 tt-slim
 * 批 B 历史机器退役整体删除。
 */

import { useApisStore } from './store';

export function initApis(): void {
    useApisStore();
}

export { useApisStore } from './store';
export { TASK_PARAMS } from './task-defaults';
export { REASONING_EFFORTS } from './task-profiles';
export type { ReasoningEffort } from './task-profiles';
export type { ApiProvider } from './types';
