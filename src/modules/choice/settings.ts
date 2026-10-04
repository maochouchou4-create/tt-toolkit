/**
 * choice 设置 store（Pinia）：API 配置＋生成参数＋点击行为。
 * 真相源＝storage 全局域（choice 键）；读透传＋写穿＋revision 失效信号
 * （nav/prompts store 同款纪律，store 不落值快照）。
 */
import { defineStore } from 'pinia';
import { choiceStorage, createApiConfig, type ApiConfig, type ChoiceGenParams } from './api';

export const useChoiceSettingsStore = defineStore('tt-choice-settings', {
    state: () => ({
        /** 写穿计数：读透传 getter 的失效信号 */
        revision: 0,
        /** 编辑中的 API 配置（表单内存态；点保存写穿 storage） */
        draft: null as ApiConfig | null,
    }),
    getters: {
        apis(): ApiConfig[] {
            void this.revision;
            return choiceStorage.readDomain().apis;
        },
        activeApiId(): string {
            void this.revision;
            return choiceStorage.readDomain().activeApiId;
        },
        gen(): ChoiceGenParams {
            void this.revision;
            return choiceStorage.readDomain().gen;
        },
    },
    actions: {
        saveApi(api: ApiConfig) {
            choiceStorage.upsertApi(api);
            if (this.draft?.id === api.id) this.draft = null;
            this.revision++;
        },
        removeApi(id: string) {
            choiceStorage.deleteApi(id);
            if (this.draft?.id === id) this.draft = null;
            this.revision++;
        },
        activateApi(id: string) {
            choiceStorage.setActiveApi(id);
            this.revision++;
        },
        updateGen(patch: Partial<ChoiceGenParams>) {
            choiceStorage.updateGenParams(patch);
            this.revision++;
        },
        startDraft(base?: ApiConfig) {
            this.draft = base ? { ...base } : createApiConfig('新端点');
        },
        updateDraft(patch: Partial<ApiConfig>) {
            if (!this.draft) return;
            this.draft = { ...this.draft, ...patch };
        },
        cancelDraft() {
            this.draft = null;
        },
    },
});
