/**
 * 提示词子系统 store（Pinia）。
 *
 * 真相源纪律（storage 域是宿主的非响应式对象）：全部读取走读透传、
 * 写入走写穿 action＋revision bump 失效信号；store 不落值快照
 * （快照＝第二真相源）。存储读写本体在 ./storage（同构 storage 分件）。
 *
 * 走向域不在本 store：剧情走向（chat 域 storyDirection＋全局域
 * directionPresets）归 choice 模块（modules/choice/direction.ts）——
 * 生成消费方只有 choice 管线，域随消费方归位。模板编辑面已删除：
 * 模板内置于代码（defaults），engine 照常读；modules[].enabled 仍由
 * 引擎消费（行为面，非 UI 面）。
 */
import { defineStore } from 'pinia';
import { readPromptConfigs } from './storage';
import type { PromptConfig, TaskKey } from './types';

export const usePromptsStore = defineStore('tt-prompts', {
    state: () => ({
        /** 写穿计数：读透传 getter 的失效信号 */
        revision: 0,
    }),
    getters: {
        /** 按任务取生效配置（函数式 getter——Pinia 传参惯用法） */
        configFor(): (task: TaskKey) => PromptConfig | null {
            void this.revision;
            const configs = readPromptConfigs();
            return task => configs[task] ?? null;
        },
        /** choice 任务生效配置 */
        effectiveConfig(): PromptConfig | null {
            void this.revision;
            return readPromptConfigs().choice ?? null;
        },
    },
});
