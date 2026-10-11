/**
 * 服务商表＋任务档案 Pinia store（「API」tab 用）。
 *
 * revision 失效信号纪律照 choice/settings：storage 写穿后 bump revision，
 * getters 读取时 void this.revision 建立依赖，保证列表与存储同步
 * （沿 revision 信号，不做对象身份比较——Pinia reactive proxy 包装会
 * 让裸引用比较恒失配）。
 */

import { defineStore } from 'pinia';
import { createEndpoint, deleteEndpoint, readApiDomain, readJailbreakPreset, upsertEndpoint, writeJailbreakPreset } from './storage';
import { mutateTaskProfiles, readTaskProfiles, setRouteForAllTasks, type TaskProfile, type TaskProfilesDomain } from './task-profiles';
import type { TaskId } from '@/tasks';
import type { ApiProvider } from './types';
import { fetchModels } from './client';
import { listOpenAIPresetNames } from '@/host';

export const useApisStore = defineStore('tt-apis', {
    state: () => ({
        /** 失效信号：服务商表/任务档案任何写穿后自增。 */
        revision: 0,
        draft: null as ApiProvider | null,
        /** 拉模型清单的最近一次结果消息（成败均落这里供 UI 显示）。 */
        fetchStatus: null as { ok: boolean; message: string } | null,
        /** 宿主 openai 预设名清单（破限注入卡下拉源；onActivate 刷新——tab 容器只挂载一次）。 */
        presetNames: [] as string[],
    }),
    getters: {
        endpoints(): ApiProvider[] {
            void this.revision;
            return readApiDomain();
        },
        /** 任务档案各任务行（任务模型卡读写源）。 */
        taskProfiles(): TaskProfilesDomain {
            void this.revision;
            return readTaskProfiles();
        },
        /** 选中破限预设名（''＝不启用；API 页「生成注入」卡读写）。 */
        jailbreakPreset(): string {
            void this.revision;
            return readJailbreakPreset();
        },
    },
    actions: {
        /** 增改单条服务商（按 id 整体替换；新增即追加）。 */
        saveProvider(provider: ApiProvider) {
            upsertEndpoint(provider);
            this.revision += 1;
        },
        /** 删除服务商（UI 层已 confirm；被档案引用的任务行由存储层联动重置）。 */
        removeEndpoint(id: string) {
            deleteEndpoint(id);
            this.revision += 1;
        },
        /** 单行任务档案写通道（任务模型卡的唯一写口）。 */
        updateTaskProfile(task: TaskId, patch: Partial<TaskProfile>) {
            mutateTaskProfiles(profiles => {
                profiles[task] = { ...profiles[task], ...patch };
            });
            this.revision += 1;
        },
        /** 批量设置行的写通道（各行同换服务商＋模型；调参档不动）。 */
        applyRouteToAllTasks(providerId: string, model: string) {
            setRouteForAllTasks(providerId, model);
            this.revision += 1;
        },
        /** 选择破限预设（''＝关闭；下次请求即生效）。 */
        selectJailbreakPreset(name: string) {
            writeJailbreakPreset(name);
            this.revision += 1;
        },
        /** 刷新宿主预设名清单（tab onActivate 与挂载时调用——宿主侧增删预设后回本页即新鲜）。 */
        refreshPresetNames() {
            this.presetNames = listOpenAIPresetNames();
        },
        /** 新建或复制服务商骨架进编辑区（拉取状态随会话清零——上一次拉取的结果文案不属于新编辑会话）。 */
        startDraft(base?: ApiProvider) {
            this.draft = base ? { ...base, models: [...base.models] } : createEndpoint('新服务商');
            this.fetchStatus = null;
        },
        updateDraft(patch: Partial<ApiProvider>) {
            if (!this.draft) return;
            this.draft = { ...this.draft, ...patch };
        },
        cancelDraft() {
            this.draft = null;
            this.fetchStatus = null;
        },
        /**
         * 拉模型清单（直连 Bearer；结果写进草稿的 models 缓存，保存落档——
         * 拉取本身即 url+key 的健康检查）。返回本次清单：updateDraft 整体
         * 替换 draft 对象，调用方 await 前捕获的旧引用读不到新值——结果
         * 一律走返回值，不回读可变状态。
         */
        async fetchModelList(): Promise<string[]> {
            if (!this.draft) return [];
            const models = await fetchModels(this.draft.url, this.draft.key);
            this.updateDraft({ models });
            return models;
        },
    },
});
