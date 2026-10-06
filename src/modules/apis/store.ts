/**
 * 统一端点表 Pinia store（「API」tab 用）。
 *
 * revision 失效信号纪律照 choice/settings：storage 写穿后 bump revision，
 * getters 读取时 void this.revision 建立依赖，保证列表与存储同步。
 */

import { defineStore } from 'pinia';
import { createEndpoint, deleteEndpoint, readActiveEndpointId, readApiDomain, readJailbreakPreset, resolveEndpointById, setActiveEndpointId, upsertEndpoint, writeJailbreakPreset } from './storage';
import type { ApiEndpoint } from './types';
import { fetchModels, testConnection } from './client';
import { listOpenAIPresetNames } from '@/host';

export interface ConnectionStatus {
    ok: boolean;
    message: string;
}

export const useApisStore = defineStore('tt-apis', {
    state: () => ({
        /** 失效信号：端点表任何写穿后自增。 */
        revision: 0,
        draft: null as ApiEndpoint | null,
        /** 「拉取模型清单」结果（按端点暂存）。 */
        modelOptions: [] as string[],
        /** 测连结果（成功/失败均落这里供 UI 显示）。 */
        connectionStatus: null as ConnectionStatus | null,
        /** 宿主 openai 预设名清单（破限注入卡下拉源；onActivate 刷新——tab 容器只挂载一次）。 */
        presetNames: [] as string[],
    }),
    getters: {
        endpoints(): ApiEndpoint[] {
            void this.revision;
            return readApiDomain();
        },
        /** 全局活动端点 id（''＝未选态；写穿「使用」/删除联动经 revision 失效）。 */
        activeEndpointId(): string {
            void this.revision;
            return readActiveEndpointId();
        },
        /** 全局活动端点实体（未选/指向已删端点＝null）。 */
        activeEndpoint(): ApiEndpoint | null {
            void this.revision;
            const id = this.activeEndpointId;
            return id === '' ? null : resolveEndpointById(id);
        },
        /** 选中破限预设名（''＝不启用；API 页「生成注入」卡读写）。 */
        jailbreakPreset(): string {
            void this.revision;
            return readJailbreakPreset();
        },
    },
    actions: {
        /** 增改单条端点（按 id 整体替换；新增即追加）。 */
        saveEndpoint(endpoint: ApiEndpoint) {
            upsertEndpoint(endpoint);
            this.revision += 1;
        },
        /** 删除端点（UI 层已 confirm；删活动端点时全局选中键由存储层联动清空）。 */
        removeEndpoint(id: string) {
            deleteEndpoint(id);
            this.revision += 1;
        },
        /** 「使用」该端点：写全局活动键（两任务即时生效）。 */
        useEndpoint(id: string) {
            setActiveEndpointId(id);
            this.revision += 1;
        },
        /** 选择破限预设（''＝关闭；两任务下次请求即生效）。 */
        selectJailbreakPreset(name: string) {
            writeJailbreakPreset(name);
            this.revision += 1;
        },
        /** 刷新宿主预设名清单（tab onActivate 与挂载时调用——宿主侧增删预设后回本页即新鲜）。 */
        refreshPresetNames() {
            this.presetNames = listOpenAIPresetNames();
        },
        /** 新建或复制端点骨架进编辑区。 */
        startDraft(base?: ApiEndpoint) {
            this.draft = base ? { ...base } : createEndpoint('新端点');
        },
        updateDraft(patch: Partial<ApiEndpoint>) {
            if (!this.draft) return;
            this.draft = { ...this.draft, ...patch };
        },
        cancelDraft() {
            this.draft = null;
        },
        /** 拉模型清单（直连 Bearer；结果暂存供下拉选择）。 */
        async fetchModelList(url: string, key: string) {
            this.modelOptions = await fetchModels(url, key);
        },
        /** 测连（直连 Bearer 发一条最小消息；成败消息落 connectionStatus）。 */
        async runTestConnection(url: string, key: string, model: string) {
            const res = await testConnection(url, key, model);
            if (res.ok) {
                this.connectionStatus = { ok: true, message: '连接成功，端点可用' };
            } else {
                let detail = `HTTP ${res.status}`;
                try {
                    const text = await res.text();
                    if (text) detail = `${detail}：${text.slice(0, 200)}`;
                } catch {
                    // 响应体读不出＝仅报状态码
                }
                this.connectionStatus = { ok: false, message: `连接失败（${detail}）——请检查地址、密钥与模型名` };
            }
        },
    },
});
