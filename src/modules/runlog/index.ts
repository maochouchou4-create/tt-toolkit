/**
 * runlog 模块入口：运行日志的对外单门面。
 *
 * 只开消费面——壳的日志 tab 消费 store 与记录类型两条，其余内部形状
 * （记号、任务别名）不经门面透出，避免门面变成域内实现的转发层。
 */

export { useRunlogStore } from './store';
export type { RunRecord } from './types';
