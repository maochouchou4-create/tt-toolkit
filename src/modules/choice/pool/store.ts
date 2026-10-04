/**
 * 条目池 store（Pinia）：PoolTab 的读写桥。
 * 真相源＝choice 域（storage 层 CRUD）；读透传＋写穿＋revision 失效信号
 * （choice/settings store 同款纪律，store 不落值快照）。
 *
 * 编辑草稿留在组件内存态（照 ChoiceSettingsTab 的 draft 先例），保存才写穿。
 */

import { defineStore } from 'pinia';
import { choiceStorage } from '../api';
import { readLegacyChoice, importLegacyChoice, importPoolBackup, parsePoolBackup, exportPoolBackup, type PoolImportReport } from './import';
import {
    createPoolConfig,
    createPoolEntry,
    deletePoolConfig,
    deletePoolEntry,
    readChatPoolConfigId,
    readPoolData,
    setChatPoolConfigId,
    setDefaultPoolConfig,
    upsertPoolConfig,
    upsertPoolEntry,
} from './storage';
import { resolvePoolConfig } from './resolver';
import type { PoolConfig, PoolEntry, PoolGenParams } from './types';

export const usePoolStore = defineStore('tt-pool', {
    state: () => ({
        /** 写穿计数：读透传 getter 的失效信号 */
        revision: 0,
    }),
    getters: {
        masterPool(): PoolEntry[] {
            void this.revision;
            return readPoolData().masterPool;
        },
        poolConfigs(): PoolConfig[] {
            void this.revision;
            return readPoolData().poolConfigs;
        },
        /** 池抽取参数（choice 域 gen 的池参数部分）。 */
        poolGen(): PoolGenParams {
            void this.revision;
            return choiceStorage.readDomain().gen;
        },
        /** chat 域绑定（空串＝用默认）。 */
        chatPoolConfigId(): string {
            void this.revision;
            return readChatPoolConfigId();
        },
        /** 绑定级联解析出的生效配置（chat 命中→默认兜底；无配置=null=全池回退）。 */
        effectiveConfig(): PoolConfig | null {
            void this.revision;
            return resolvePoolConfig(readPoolData().poolConfigs, readChatPoolConfigId());
        },
        /** 旧版 extension_settings.choice 是否在场（导入卡的入口显隐）。 */
        legacyAvailable(): boolean {
            return readLegacyChoice() !== null;
        },
    },
    actions: {
        saveEntry(entry: PoolEntry) {
            upsertPoolEntry(entry);
            this.revision++;
        },
        newEntry(): PoolEntry {
            return createPoolEntry();
        },
        removeEntry(entryId: string) {
            deletePoolEntry(entryId);
            this.revision++;
        },
        saveConfig(config: PoolConfig) {
            upsertPoolConfig(config);
            this.revision++;
        },
        newConfig(): PoolConfig {
            return createPoolConfig('新池配置');
        },
        duplicateConfig(base: PoolConfig): PoolConfig {
            // 复制语义：内容与引用全量拷贝，id 换新、去掉默认身份（默认必须唯一）
            const copy = createPoolConfig(`${base.name} 副本`);
            copy.entries = base.entries.map(ref => ({ ...ref }));
            return copy;
        },
        removeConfig(configId: string): boolean {
            const ok = deletePoolConfig(configId);
            if (ok) {
                // 删的可能是 chat 绑定指向的配置：绑定悬空＝回退默认，语义安全，无需特判
                this.revision++;
            }
            return ok;
        },
        markDefault(configId: string) {
            setDefaultPoolConfig(configId);
            this.revision++;
        },
        /** chat 域绑定（空串＝默认；chat 域立即落盘）。 */
        setChatBinding(configId: string) {
            setChatPoolConfigId(configId);
            this.revision++;
        },
        updatePoolGen(patch: Partial<PoolGenParams>) {
            choiceStorage.updateGenParams(patch);
            this.revision++;
        },
        /** 一键导入旧版数据（extension_settings.choice）。 */
        importLegacy(): PoolImportReport | null {
            const report = importLegacyChoice();
            this.revision++;
            return report;
        },
        /** 导出本仓备份 JSON 文本。 */
        exportJson(): string {
            return exportPoolBackup();
        },
        /** 导入本仓备份文本（校验器拒畸形）。 */
        importJson(text: string): { ok: true; report: PoolImportReport } | { ok: false; error: string } {
            const parsed = parsePoolBackup(text);
            if (!parsed.ok) return { ok: false, error: parsed.error };
            const report = importPoolBackup(parsed.data);
            this.revision++;
            return { ok: true, report };
        },
    },
});
