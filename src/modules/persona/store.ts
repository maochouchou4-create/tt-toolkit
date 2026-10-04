/**
 * PersonaWeaver fork 状态层（批D 平移，Pinia）。
 *
 * 写时机重设计（相对上游 fork）：旧版 1.2s 防抖逐键热存改为
 * 「store 内存态 + 显式保存点」——生成落地/确认 diff/载入（userContext）、
 * 保存配置与配置档 CRUD（localConfig）、生成启动（世界书勾选快照）。
 * 平时表单编辑只动内存，不写全局域（消旧版每次键击写 localStorage 的
 * IO 放大）。
 *
 * 互斥纪律：isProcessing 对生成/润色/重 roll 全局互斥（旧模块私有
 * isProcessing 同语义）；lastRun 记忆最近一次请求（重 roll 语义）。
 */

import { defineStore } from 'pinia';
import {
    buildPresetOptions,
    getContextWorldBooks,
    getCharacterGreetingsList,
    getPersonaDescription,
    getTavernContext,
    getUserDisplayName,
    getWorldBookEntries,
    hostWindow,
    listWorldInfoNames,
    upsertPersona,
    type WorldBookEntrySummary,
} from '@/host';
import { createTtlog } from '@/host/ttlog';
import { testConnection } from '@/modules/apis/client';
import { resolveEndpointById } from '@/modules/apis/storage';
import { collectWorldInfoContext, getPresetHintText, runGeneration, type GenerationApiConfig } from './generation';
import { computeDiffBlocks, assembleDiffResult, type DiffBlock } from './diff';
import { syncPersonaToWorldInfo, listWorldBookEntriesForLoad } from './worldbook';
import { TEXT } from './strings';
import {
    clampTimeout,
    loadWiSelectionFor,
    readPersonaDomain,
    writePersonaDomain,
    type LocalConfig,
} from './storage';

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
    mode: 'initial' | 'refine';
    request: string;
    currentText: string;
    wiText: string;
    greetingsText: string;
}

function snapshotLocalConfig(config: LocalConfig): LocalConfig {
    return { ...config, extraBooks: [...config.extraBooks] };
}

/**
 * 生成调用面配置解析：endpointId → 统一端点表实体。端点缺失（未配置或
 * 已被删除）返回 null，由 generate/refine/reroll 统一 fail fast。
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
        config: snapshotLocalConfig(readPersonaDomain().localConfig),
        /** 预设选择（'current'/'pure'/预设名）。 */
        generationPreset: readPersonaDomain().uiState.generationPreset,
        /** 人设分区：需求框/结果框/润色意见框。 */
        requestText: readPersonaDomain().userContext.request,
        resultText: readPersonaDomain().userContext.result,
        refineText: '',
        /** diff 取舍视图状态（确认前不写结果框）。 */
        diffBlocks: [] as DiffBlock[],
        showDiff: false,
        /** 生成互斥与进度文案。 */
        isProcessing: false,
        processingLabel: '',
        /** 最近一次请求（重 roll 记忆）。 */
        lastRun: null as LastRunDescriptor | null,
        /** 参考分区：书目/条目/勾选缓存/问候语。 */
        availableBooks: [] as string[],
        bookEntries: {} as Record<string, WorldBookEntrySummary[]>,
        checkedByBook: {} as Record<string, string[]>,
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
            this.config = snapshotLocalConfig(domain.localConfig);
            this.generationPreset = domain.uiState.generationPreset;
            this.requestText = domain.userContext.request;
            this.resultText = domain.userContext.result;
            this.diffBlocks = [];
            this.showDiff = false;
            this.refineText = '';
        },

        /**
         * 宿主派生数据刷新（onActivate 快照）：书目/问候语/
         * 载入候选。只读宿主，不写域。
         */
        refreshHostData() {
            this.greetings = getCharacterGreetingsList();
            void listBooks(this.config.extraBooks).then(books => {
                this.availableBooks = books;
            });
            void listWorldBookEntriesForLoad(getUserDisplayName()).then(candidates => {
                this.loadCandidates = candidates;
            });
        },

        /** 惰性装载单书条目（勾选初始化：已存选择 → enabled 兜底）。 */
        async ensureBookEntries(book: string) {
            if (this.bookEntries[book]) return;
            const entries = await getWorldBookEntries(book);
            this.bookEntries[book] = entries;
            if (!this.checkedByBook[book]) {
                const saved = loadWiSelectionFor(this.charKey, book);
                this.checkedByBook[book] = saved && saved.length > 0
                    ? saved
                    : entries.filter(e => e.enabled).map(e => String(e.uid));
            }
        },

        // ---------------- 显式保存点 ----------------

        /** 保存 API 配置＋预设选择。 */
        persistConfig() {
            writePersonaDomain(domain => {
                domain.localConfig = snapshotLocalConfig(this.config);
                domain.uiState.generationPreset = this.generationPreset;
                // 钉选常驻书与 extraBooks 同源（旧版两键合一的写侧收敛）
                domain.pinnedBooks = [...this.config.extraBooks];
            });
        },

        /** 保存编辑现场（需求/结果）。 */
        persistUserContext() {
            writePersonaDomain(domain => {
                domain.userContext = {
                    request: this.requestText,
                    result: this.resultText,
                    hasResult: this.resultText.trim().length > 0,
                };
            });
        },

        /** 世界书勾选快照进域（生成/润色启动时＝自然保存点）。 */
        persistSelections() {
            const charKey = this.charKey;
            const snapshot = { ...this.checkedByBook };
            writePersonaDomain(domain => {
                domain.wiSelection[charKey] = snapshot;
            });
        },

        // ---------------- 参考分区交互 ----------------

        setCheck(book: string, uid: number, on: boolean) {
            const list = this.checkedByBook[book] ?? [];
            const id = String(uid);
            this.checkedByBook[book] = on ? [...new Set([...list, id])] : list.filter(x => x !== id);
        },

        isBookChecked(book: string, uid: number): boolean {
            return (this.checkedByBook[book] ?? []).includes(String(uid));
        },

        /** 钉选/取消钉选常驻书（写入 extraBooks；立即落域）。 */
        togglePin(book: string) {
            const pinned = this.config.extraBooks.includes(book);
            this.config.extraBooks = pinned
                ? this.config.extraBooks.filter(b => b !== book)
                : [...this.config.extraBooks, book];
            this.availableBooks = [...new Set([...this.availableBooks, book])].sort();
            this.persistConfig();
            toast(pinned ? TEXT.TOAST_UNPINNED(book) : TEXT.TOAST_PINNED(book));
        },

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

        // ---------------- 人设分区：生成/润色/重 roll ----------------

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
            this.refineText = '';
            this.diffBlocks = [];
            this.showDiff = false;
            try {
                this.persistSelections();
                const wiText = await collectWorldInfoContext({
                    extraBooks: [...this.config.extraBooks],
                    checkedByBook: { ...this.checkedByBook },
                    charKey: this.charKey,
                });
                const greetingsText = this.selectedGreetingIndex !== null
                    ? (this.greetings[this.selectedGreetingIndex]?.content ?? '')
                    : '';
                const run: LastRunDescriptor = {
                    mode: 'initial',
                    request: this.requestText,
                    currentText: '',
                    wiText,
                    greetingsText,
                };
                this.lastRun = run;
                const result = await runGeneration({
                    ...api,
                    mode: 'initial',
                    request: run.request,
                    currentText: '',
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

        /** 润色（单段 + diff 取舍视图）。 */
        async refine() {
            if (this.isProcessing) return;
            const api = buildApiConfig(this.config);
            if (!api) {
                toast(TEXT.TOAST_NO_ENDPOINT, 'error');
                return;
            }
            if (!this.refineText.trim()) {
                toast(TEXT.TOAST_REFINE_EMPTY, 'warning');
                return;
            }
            if (!this.resultText.trim()) {
                toast(TEXT.TOAST_NO_VALID_CONTENT, 'warning');
                return;
            }
            this.isProcessing = true;
            this.processingLabel = '润色中…';
            this.diffBlocks = [];
            this.showDiff = false;
            try {
                this.persistSelections();
                const wiText = await collectWorldInfoContext({
                    extraBooks: [...this.config.extraBooks],
                    checkedByBook: { ...this.checkedByBook },
                    charKey: this.charKey,
                });
                const run: LastRunDescriptor = {
                    mode: 'refine',
                    request: this.refineText,
                    currentText: this.resultText,
                    wiText,
                    greetingsText: '',
                };
                this.lastRun = run;
                const newText = await runGeneration({
                    ...api,
                    mode: 'refine',
                    request: run.request,
                    currentText: run.currentText,
                    wiText,
                    greetingsText: '',
                    generationPreset: this.generationPreset,
                    onPrefillRetry: () => toast(TEXT.TOAST_PREFILL_RETRY),
                    onProgress: label => { this.processingLabel = label; },
                });
                this.diffBlocks = computeDiffBlocks(this.resultText, newText);
                this.showDiff = true;
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
            this.processingLabel = run.mode === 'refine' ? '润色中…' : '生成中…';
            this.diffBlocks = [];
            this.showDiff = false;
            try {
                const newText = await runGeneration({
                    ...api,
                    mode: run.mode,
                    request: run.request,
                    currentText: run.currentText,
                    wiText: run.wiText,
                    greetingsText: run.greetingsText,
                    generationPreset: this.generationPreset,
                    onPrefillRetry: () => toast(TEXT.TOAST_PREFILL_RETRY),
                    onProgress: label => { this.processingLabel = label; },
                });
                if (run.mode === 'refine') {
                    this.diffBlocks = computeDiffBlocks(run.currentText, newText);
                    this.showDiff = true;
                } else {
                    this.resultText = newText;
                    this.persistUserContext();
                }
                toast(TEXT.TOAST_REROLLED);
            } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'error');
            } finally {
                this.isProcessing = false;
                this.processingLabel = '';
            }
        },

        /** diff 取舍：切换某块采纳侧。 */
        setBlockActive(index: number, side: 'old' | 'new') {
            const block = this.diffBlocks[index];
            if (block && block.type === 'diff') block.active = side;
        },

        /** diff 确认：拼装取舍结果写回结果框（落地保存点）。 */
        confirmDiff() {
            if (this.diffBlocks.length === 0) {
                toast(TEXT.TOAST_NO_CHANGES, 'warning');
                return;
            }
            this.resultText = assembleDiffResult(this.diffBlocks);
            this.diffBlocks = [];
            this.showDiff = false;
            this.persistUserContext();
            toast(TEXT.TOAST_APPLIED);
        },

        /** 划词润色：把选中片段的修改意见模板追加进润色框（事件直挂，砍旧 100ms 防抖）。 */
        appendRefineSelection(selected: string) {
            const piece = `对 "${selected}" 的修改意见为：`;
            this.refineText = this.refineText ? `${this.refineText}\n${piece}` : piece;
        },

        /** 清空（UI 层 confirm）。 */
        clearAll() {
            this.requestText = '';
            this.resultText = '';
            this.refineText = '';
            this.diffBlocks = [];
            this.showDiff = false;
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
            this.diffBlocks = [];
            this.showDiff = false;
            this.persistUserContext();
            toast(TEXT.TOAST_LOAD_CURRENT);
        },

        /** 载入世界书条目进结果框（UI 选择器确认后调用）。 */
        loadWorldBookEntry(book: string, uid: number) {
            const entry = this.bookEntries[book]?.find(e => e.uid === uid) ?? this.loadCandidates.find(c => c.book === book && c.entry.uid === uid)?.entry;
            if (!entry || !entry.content.trim()) {
                toast(TEXT.TOAST_NO_VALID_CONTENT, 'warning');
                return;
            }
            this.resultText = entry.content;
            this.diffBlocks = [];
            this.showDiff = false;
            this.persistUserContext();
            toast(TEXT.TOAST_RESET_TO_WI);
        },
    },
});

/** 参考分区的书目清单（宿主全量书目 + 角色绑定书 + 钉选书，有序去重）。 */
async function listBooks(extraBooks: string[]): Promise<string[]> {
    return [...new Set([...listWorldInfoNames(), ...getContextWorldBooks(), ...extraBooks])].filter(Boolean).sort();
}
