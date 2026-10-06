/**
 * PersonaWeaver fork 状态层（批D 平移，Pinia）。
 *
 * 写时机重设计（相对上游 fork）：旧版 1.2s 防抖逐键热存改为
 * 「store 内存态 + 显式保存点」——生成落地/载入（userContext）、
 * 保存配置与配置档 CRUD（localConfig）。平时表单编辑只动内存，
 * 不写全局域（消旧版每次键击写 localStorage 的 IO 放大）。
 *
 * 互斥纪律：isProcessing 对生成/重 roll 全局互斥（旧模块私有
 * isProcessing 同语义）；lastRun 记忆最近一次请求（重 roll 语义）。
 * 会话感知：CHAT_CHANGED 到达时 selectedGreetingIndex/lastRun 无条件
 * 清空（开场白选择不跨会话携带；旧会话 wiText 快照不得被新会话
 * reroll 消费），宿主快照无条件重拉（读取廉价且 loadCandidates 依赖
 * userName 不在指纹内，门控会漏刷；会话身份指纹仅用于日志观测）。
 * 世界书：全量注入（无勾选/钉选面），参考分区只读展示绑定书单。
 */

import { defineStore } from 'pinia';
import {
    buildPresetOptions,
    getContextWorldBooks,
    getCharacterGreetingsList,
    getPersonaDescription,
    getTavernContext,
    getUserDisplayName,
    hostWindow,
    upsertPersona,
    type WorldBookEntrySummary,
} from '@/host';
import { createTtlog } from '@/host/ttlog';
import { testConnection } from '@/modules/apis/client';
import { resolveEndpointById } from '@/modules/apis/storage';
import { collectWorldInfoContext, getPresetHintText, runGeneration, type GenerationApiConfig } from './generation';
import { syncPersonaToWorldInfo, listWorldBookEntriesForLoad } from './worldbook';
import { TEXT } from './strings';
import { clampTimeout, readPersonaDomain, writePersonaDomain, type LocalConfig } from './storage';

const log = createTtlog('modules/persona/store');

// 主窗口内 toastr 为全局；不可用时退回日志，不静默丢失用户反馈（nav 同款纪律）
function toast(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    try {
        const t = hostWindow.toastr;
        const fn = t?.[level] ?? t?.info;
        if (fn) fn.call(t, message);
        else log.info(`toast-fallback ${level}: ${message}`);
    } catch {
        log.info(`toast-fallback ${level}: ${message}`);
    }
}

/** 最近一次生成请求的记忆（重 roll 同参再来）。 */
interface LastRunDescriptor {
    request: string;
    wiText: string;
    greetingsText: string;
}

/**
 * 生成调用面配置解析：endpointId → 统一端点表实体。端点缺失（未配置或
 * 已被删除）返回 null，由 generate/reroll 统一 fail fast。
 */
function buildApiConfig(config: LocalConfig): GenerationApiConfig | null {
    const endpoint = resolveEndpointById(config.endpointId);
    if (!endpoint) return null;
    return {
        endpoint,
        stream: config.stream,
        thinkingEffort: config.thinkingEffort,
        timeoutSec: clampTimeout(config.timeoutSec),
    };
}

export const usePersonaStore = defineStore('tt-persona', {
    state: () => ({
        /** API 配置（表单内存态；保存点写域）。 */
        config: readPersonaDomain().localConfig,
        /** 预设选择（'current'/'pure'/预设名）。 */
        generationPreset: readPersonaDomain().uiState.generationPreset,
        /** 人设分区：需求框/结果框。 */
        requestText: readPersonaDomain().userContext.request,
        resultText: readPersonaDomain().userContext.result,
        /** 生成互斥与进度文案。 */
        isProcessing: false,
        processingLabel: '',
        /** 最近一次请求（重 roll 记忆）。 */
        lastRun: null as LastRunDescriptor | null,
        /** 参考分区：当前会话绑定书单（只读展示，全量注入）与问候语。 */
        boundBooks: [] as string[],
        greetings: [] as Array<{ label: string; content: string }>,
        selectedGreetingIndex: null as number | null,
        /** 生成通道分区：测连状态。 */
        connectionStatus: '',
        /** 载入世界书条目的候选清单（onActivate 时刷新）。 */
        loadCandidates: [] as Array<{ book: string; entry: WorldBookEntrySummary }>,
    }),

    getters: {
        /** 当前角色键（字符串口径，'||' 兜底——勿用 === 比较 this_chid）。 */
        charKey(): string {
            return getTavernContext()?.characterId || 'global_no_char';
        },
        /** 会话身份指纹（charKey＋绑定书单）：CHAT_CHANGED 时判快照是否需重拉。 */
        sessionFingerprint(): string {
            return `${this.charKey}\u0001${this.boundBooks.join('\u0001')}`;
        },
        hasResult(): boolean {
            return this.resultText.trim().length > 0;
        },
        presetHint(): string {
            return getPresetHintText(this.generationPreset);
        },
        /** preset 下拉选项（current/pure 两默认项+具名预设；:value 绑定消旧 option 注入风险）。 */
        presetOptions(): Array<{ value: string; label: string }> {
            return buildPresetOptions().map(name => ({
                value: name,
                label: name === 'current' ? '当前预设' : name === 'pure' ? '纯净模式（无系统段）' : name,
            }));
        },
    },

    actions: {
        // ---------------- 初始化与宿主数据刷新 ----------------

        /** 模块初始化（浏览器/node 双流；幂等）。 */
        init() {
            this.loadFromDomain();
            this.refreshHostData();
        },

        /** 从全局域读快照进内存态（显式保存点之外的唯一读时机）。 */
        loadFromDomain() {
            const domain = readPersonaDomain();
            this.config = domain.localConfig;
            this.generationPreset = domain.uiState.generationPreset;
            this.requestText = domain.userContext.request;
            this.resultText = domain.userContext.result;
        },

        /**
         * 宿主派生数据刷新（init/onActivate 快照）：问候语/绑定书单/
         * 载入候选。只读宿主，不写域。
         */
        refreshHostData() {
            this.greetings = getCharacterGreetingsList();
            this.boundBooks = getContextWorldBooks();
            void listWorldBookEntriesForLoad(getUserDisplayName()).then(candidates => {
                this.loadCandidates = candidates;
            });
        },

        /**
         * CHAT_CHANGED 处理（订阅在 persona/index.ts init 挂载）：
         * selectedGreetingIndex 与 lastRun 无条件清空（不跨会话携带——
         * lastRun 里的 wiText 是旧会话快照，reroll 禁用直到新生成）；
         * 宿主派生快照无条件重拉（门控会漏刷 userName 派生面，见头注）。
         */
        handleChatChanged() {
            const fingerprintBefore = this.sessionFingerprint;
            this.selectedGreetingIndex = null;
            this.lastRun = null;
            this.refreshHostData();
            if (this.sessionFingerprint !== fingerprintBefore) {
                log.info(`会话切换：指纹 ${fingerprintBefore} → ${this.sessionFingerprint}，宿主快照已重拉`);
            }
        },

        // ---------------- 显式保存点 ----------------

        /** 保存 API 配置＋预设选择。 */
        persistConfig() {
            writePersonaDomain(domain => {
                domain.localConfig = { ...this.config };
                domain.uiState.generationPreset = this.generationPreset;
            });
        },

        /** 保存编辑现场（需求/结果）。 */
        persistUserContext() {
            writePersonaDomain(domain => {
                domain.userContext = {
                    request: this.requestText,
                    result: this.resultText,
                };
            });
        },

        // ---------------- 参考分区交互 ----------------

        selectGreeting(index: number | null) {
            this.selectedGreetingIndex = index;
        },

        selectPreset(name: string) {
            this.generationPreset = name;
            this.persistConfig();
        },

        // ---------------- 生成通道分区交互 ----------------

        /** 保存生成通道配置（端点引用＋任务参数）。 */
        saveConfig() {
            this.persistConfig();
            toast(TEXT.TOAST_CONFIG_SAVED);
        },

        /** 切换统一端点（立即落域；端点实体在 API 页维护）。 */
        setEndpointId(id: string) {
            this.config.endpointId = id;
            this.persistConfig();
        },

        async runTestConnection() {
            const endpoint = resolveEndpointById(this.config.endpointId);
            if (!endpoint) {
                this.connectionStatus = TEXT.TOAST_NO_ENDPOINT;
                toast(TEXT.TOAST_NO_ENDPOINT, 'warning');
                return;
            }
            try {
                const res = await testConnection(endpoint.url, endpoint.key, endpoint.model);
                this.connectionStatus = res.ok ? TEXT.TOAST_CONN_OK : TEXT.TOAST_CONN_STATUS(String(res.status));
                toast(this.connectionStatus, res.ok ? 'success' : 'error');
            } catch (err) {
                this.connectionStatus = err instanceof Error ? err.message : String(err);
                toast(TEXT.TOAST_CONN_FAIL, 'error');
            }
        },

        // ---------------- 人设分区：生成/重 roll ----------------

        /** 生成（首次两段链）。互斥：isProcessing 期间静默忽略。 */
        async generate() {
            if (this.isProcessing) return;
            const api = buildApiConfig(this.config);
            if (!api) {
                toast(TEXT.TOAST_NO_ENDPOINT, 'error');
                return;
            }
            this.isProcessing = true;
            this.processingLabel = '生成中…';
            try {
                const wiText = await collectWorldInfoContext();
                const greetingsText = this.selectedGreetingIndex !== null
                    ? (this.greetings[this.selectedGreetingIndex]?.content ?? '')
                    : '';
                const run: LastRunDescriptor = {
                    request: this.requestText,
                    wiText,
                    greetingsText,
                };
                this.lastRun = run;
                const result = await runGeneration({
                    ...api,
                    request: run.request,
                    wiText,
                    greetingsText,
                    generationPreset: this.generationPreset,
                    onPrefillRetry: () => toast(TEXT.TOAST_PREFILL_RETRY),
                    onProgress: label => { this.processingLabel = label; },
                });
                this.resultText = result;
                this.persistUserContext();
            } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'error');
            } finally {
                this.isProcessing = false;
                this.processingLabel = '';
            }
        },

        /** 重 roll：同 lastRun 参数再来一次。 */
        async reroll() {
            if (this.isProcessing) return;
            if (!this.lastRun) {
                toast(TEXT.TOAST_NO_LAST_REQUEST, 'warning');
                return;
            }
            const api = buildApiConfig(this.config);
            if (!api) {
                toast(TEXT.TOAST_NO_ENDPOINT, 'error');
                return;
            }
            const run = this.lastRun;
            this.isProcessing = true;
            this.processingLabel = '生成中…';
            try {
                const newText = await runGeneration({
                    ...api,
                    request: run.request,
                    wiText: run.wiText,
                    greetingsText: run.greetingsText,
                    generationPreset: this.generationPreset,
                    onPrefillRetry: () => toast(TEXT.TOAST_PREFILL_RETRY),
                    onProgress: label => { this.processingLabel = label; },
                });
                this.resultText = newText;
                this.persistUserContext();
                toast(TEXT.TOAST_REROLLED);
            } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'error');
            } finally {
                this.isProcessing = false;
                this.processingLabel = '';
            }
        },

        /** 清空（UI 层 confirm）。 */
        clearAll() {
            this.requestText = '';
            this.resultText = '';
            this.lastRun = null;
            this.persistUserContext();
        },

        // ---------------- 落库与载入 ----------------

        /** 覆盖当前人设（宿主 persona 写回通道）。 */
        async saveToPersona() {
            if (!this.resultText.trim()) {
                toast(TEXT.TOAST_EMPTY_RESULT, 'warning');
                return;
            }
            try {
                await upsertPersona(getUserDisplayName(), this.resultText);
                toast(TEXT.TOAST_SAVE_SUCCESS(getUserDisplayName()));
            } catch (err) {
                toast(TEXT.TOAST_SAVE_FAIL(err instanceof Error ? err.message : String(err)), 'error');
            }
        },

        /** 保存至世界书（USER:姓名 条目 + 智能触发词）。 */
        async saveToWorldInfo() {
            if (!this.resultText.trim()) {
                toast(TEXT.TOAST_EMPTY_RESULT, 'warning');
                return;
            }
            try {
                const result = await syncPersonaToWorldInfo(getUserDisplayName(), this.resultText);
                toast(`${TEXT.TOAST_WI_SUCCESS(result.book, result.entryTitle)}\n触发词: ${result.keywords.join(', ')}`, 'success');
            } catch (err) {
                toast(`${TEXT.TOAST_WI_WRITE_FAIL}${err instanceof Error ? err.message : String(err)}`, 'error');
            }
        },

        /** 载入当前人设进结果框。 */
        loadCurrentPersona() {
            this.resultText = getPersonaDescription();
            this.persistUserContext();
            toast(TEXT.TOAST_LOAD_CURRENT);
        },

        /** 载入世界书条目进结果框（UI 选择器确认后调用）。 */
        loadWorldBookEntry(book: string, uid: number) {
            const entry = this.loadCandidates.find(c => c.book === book && c.entry.uid === uid)?.entry;
            if (!entry || !entry.content.trim()) {
                toast(TEXT.TOAST_NO_VALID_CONTENT, 'warning');
                return;
            }
            this.resultText = entry.content;
            this.persistUserContext();
            toast(TEXT.TOAST_RESET_TO_WI);
        },
    },
});
