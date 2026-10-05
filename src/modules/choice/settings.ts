/**
 * choice 设置 store（Pinia）：任务参数＋选中端点引用＋生成参数。
 * 真相源＝storage 全局域（choice 键）；读透传＋写穿＋revision 失效信号
 * （nav/prompts store 同款纪律，store 不落值快照）。
 * 端点实体（增删改查/测连/拉模型）归统一 apis 域与 apis store。
 */
import { defineStore } from 'pinia';
import { choiceStorage, type ChoiceTaskParams, type ChoiceGenParams } from './api';

export const useChoiceSettingsStore = defineStore('tt-choice-settings', {
    state: () => ({
        /** 写穿计数：读透传 getter 的失效信号 */
        revision: 0,
    }),
    getters: {
        /** choice 任务参数（response_format 档位/思考强度/流式/温度/max_tokens）。 */
        task(): ChoiceTaskParams {
            void this.revision;
            return choiceStorage.readDomain().task;
        },
        /** 选中统一端点 id（引用 apis 全局域；实体解析在 generator）。 */
        activeEndpointId(): string {
            void this.revision;
            return choiceStorage.readDomain().activeEndpointId;
        },
        gen(): ChoiceGenParams {
            void this.revision;
            return choiceStorage.readDomain().gen;
        },
    },
    actions: {
        updateTask(patch: Partial<ChoiceTaskParams>) {
            choiceStorage.updateTask(patch);
            this.revision++;
        },
        /** 切换生成通道（引用统一端点表 id）。 */
        setActiveEndpoint(id: string) {
            choiceStorage.setActiveEndpoint(id);
            this.revision++;
        },
        updateGen(patch: Partial<ChoiceGenParams>) {
            choiceStorage.updateGenParams(patch);
            this.revision++;
        },
    },
});
