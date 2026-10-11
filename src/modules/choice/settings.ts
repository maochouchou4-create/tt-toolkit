/**
 * choice 设置 store（Pinia）：生成参数。
 * 真相源＝storage 全局域（choice 键）；读透传＋写穿＋revision 失效信号
 * （nav/prompts store 同款纪律，store 不落值快照）。
 * 流式/输出契约按任务固化于 TASK_PARAMS，温度/思考强度在任务档案
 * （API 页任务模型卡）配置；服务商实体（增删改查/拉清单）归 apis 域与 apis store。
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
