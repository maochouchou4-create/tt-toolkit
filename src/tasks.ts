/**
 * 生成任务 SSOT：任务清单唯一真相源。runlog 枚举、任务档案键、
 * API 页任务模型行、TASK_PARAMS 参数键四面同源派生（防环：本模块
 * 不 import 任何模块——runlog 被 apis/client 消费，SSOT 只能放叶子位）。
 */
export const TASKS = [
    { id: 'choice', label: '选项生成' },
    { id: 'persona', label: '人设生成' },
    { id: 'summary_small', label: '小总结' },
    { id: 'summary_big', label: '大总结' },
    { id: 'summary_judge', label: '总结判断' },
] as const;

export type TaskId = (typeof TASKS)[number]['id'];
export const TASK_IDS: readonly TaskId[] = TASKS.map(t => t.id);

export function taskLabel(id: TaskId): string {
    return TASKS.find(t => t.id === id)?.label ?? id;
}
