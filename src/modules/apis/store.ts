/**
 * 统一端点表 Pinia store（「API」tab 用）。
 *
 * revision 失效信号纪律照 choice/settings：storage 写穿后 bump revision，
 * getters 读取时 void this.revision 建立依赖，保证列表与存储同步。
 */

import { defineStore } from 'pinia';
import { createEndpoint, deleteEndpoint, readApiDomain, upsertEndpoint } from './storage';
import type { ApiEndpoint } from './types';
import { fetchModels, testConnection } from './client';

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
    }),
    getters: {
        endpoints(): ApiEndpoint[] {
            void this.revision;
            return readApiDomain();
        },
    },
    actions: {
        /** 增改单条端点（按 id 整体替换；新增即追加）。 */
        saveEndpoint(endpoint: ApiEndpoint) {
            upsertEndpoint(endpoint);
            this.revision += 1;
        },
        /** 删除端点（UI 层已 confirm；两侧域的选中引用悬空＝未配置引导兜底）。 */
        removeEndpoint(id: string) {
            deleteEndpoint(id);
            this.revision += 1;
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
