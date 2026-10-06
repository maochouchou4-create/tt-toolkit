/**
 * choice 设置 store（Pinia）：生成参数。
 * 真相源＝storage 全局域（choice 键）；读透传＋写穿＋revision 失效信号
 * （nav/prompts store 同款纪律，store 不落值快照）。
 * 任务参数已固化为 TASK_DEFAULTS（用户面零旋钮），端点实体（增删改查/
 * 测连/拉模型）与端点选择（全局活动键）归 apis 域与 apis store。
 */
import { defineStore } from 'pinia';
import { choiceStorage, type ChoiceGenParams } from './api';

export const useChoiceSettingsStore = defineStore('tt-choice-settings', {
    state: () => ({
        /** 写穿计数：读透传 getter 的失效信号 */
        revision: 0,
    }),
    getters: {
        gen(): ChoiceGenParams {
            void this.revision;
            return choiceStorage.readDomain().gen;
        },
    },
    actions: {
        updateGen(patch: Partial<ChoiceGenParams>) {
            choiceStorage.updateGenParams(patch);
            this.revision++;
        },
    },
});
