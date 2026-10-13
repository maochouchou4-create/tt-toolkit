/**
 * PersonaWeaver fork 状态层（Pinia）。
 *
 * 写时机重设计（相对上游 fork）：旧版 1.2s 防抖逐键热存改为
 * 「store 内存态 + 显式保存点」——生成落地时持久化（userContext）。
 * 平时表单编辑只动内存，不写全局域（消旧版每次键击写 localStorage
 * 的 IO 放大）。任务级预设选择已退役——预设影响统一走传输层破限
 * 注入（apis/preset-inject，API 页「生成注入」卡全局一份）。
 *
 * 互斥纪律：isProcessing 对生成/重 roll 全局互斥（旧模块私有
 * isProcessing 同语义）；lastRun 记忆最近一次请求（重 roll 语义）。
 * 会话感知：CHAT_CHANGED 到达时 lastRun 无条件清空（旧会话 wiText
 * 快照不得被新会话 reroll 消费）、开场白选择重置为默认档（greetings
 * 在场＝注入 #0；显式「不注入」仅本聊天内保留，不跨会话携带），宿主
 * 快照无条件重拉（读取廉价；会话身份指纹仅用于日志观测）。
 * 世界书：全量注入（无勾选/钉选面），参考分区只读展示绑定书单。
 */

import { defineStore } from 'pinia';
import {
    getContextWorldBooks,
    getCharacterGreetingsList,
    getTavernContext,
    getUserDisplayName,
    showToast as toast,
    upsertPersona,
} from '@/host';
import { createTtlog } from '@/host/ttlog';
import { useApisStore } from '@/modules/apis/store';
import { resolveTaskRoute } from '@/modules/apis/task-profiles';
import { collectWorldInfoContext, runGeneration, PersonaRunCancelled, type GenerationApiConfig } from './generation';
import { REVIEW_BRIEF_NOT_RUN, renderReviewBrief, type ReviewBrief } from './review';
import { TEXT } from './strings';
import { readPersonaDomain, writePersonaDomain } from './storage';

const log = createTtlog('modules/persona/store');

/** 进行中生成的取消通道（生成/重 roll 共用；null＝无进行中请求——模块级单例，与互斥标记同生命周期）。 */
let activeAbort: AbortController | null = null;

/** 最近一次生成请求的记忆（重 roll 同参再来）。 */
interface LastRunDescriptor {
    request: string;
    wiText: string;
    greetingsText: string;
}

/**
 * 生成调用面配置解析：任务路由单点解析（人设生成行档案 → 服务商表）。
 * 未配置/悬空返回 null，由 generate/reroll 统一 fail fast；温度/思考强度
 * 随路由带出（档案缺席＝任务默认档），调用面只剩路由。
 */
function buildApiConfig(): GenerationApiConfig | null {
    const route = resolveTaskRoute('persona');
    if (!route) return null;
    return { route };
}

/** store 实例类型（模块级私有装配函数专用——不扩 store 公开面）。 */
type PersonaStore = ReturnType<typeof usePersonaStore>;

/**
 * 生成单次执行（generate/reroll 共用装配）：互斥、进度、调用、落盘、
 * 异常提示一条龙。差异参数化：run＝请求快照（generate 现场收集并先记
 * lastRun；reroll 只重放既有 lastRun——批1 后 reroll 不再重收集）；
 * successToast＝成功提示（reroll 专属）。
 */
async function executeGeneration(store: PersonaStore, run: LastRunDescriptor, api: GenerationApiConfig, successToast?: string, signal?: AbortSignal): Promise<void> {
    store.isProcessing = true;
    store.processingLabel = '生成中…';
    try {
        const result = await runGeneration({
            ...api,
            request: run.request,
            wiText: run.wiText,
            greetingsText: run.greetingsText,
            onPrefillRetry: () => toast(TEXT.TOAST_PREFILL_RETRY),
            // 「端点不收 prefill」事件的组合根处置：能力记忆写穿设置域
            // （providerId 已被删时存储层返回 false 静默跳过，合法并发态）
            // ＋用户提示。生成链只报事件，不反写设置域。
            onPrefillUnsupported: () => {
                useApisStore().markPrefillUnsupported(api.route.providerId);
                toast(TEXT.TOAST_PREFILL_UNSUPPORTED);
            },
            onProgress: label => { store.processingLabel = label; },
            signal,
        });
        store.resultText = result.profile;
        store.reviewBrief = result.review;
        store.persistUserContext();
        if (successToast) toast(successToast);
    } catch (err) {
        // 取消不是失败：降级为轻提示，不作错误弹报（结果框保持原值）
        if (err instanceof PersonaRunCancelled) {
            toast(TEXT.TOAST_CANCELLED);
        } else {
            toast(err instanceof Error ? err.message : String(err), 'error');
        }
    } finally {
        store.isProcessing = false;
        store.processingLabel = '';
    }
}

export const usePersonaStore = defineStore('tt-persona', {
    state: () => {
        const domain = readPersonaDomain();
        return {
            /** 人设分区：需求框/结果框。 */
            requestText: domain.userContext.request,
            resultText: domain.userContext.result,
            /**
             * 最近一次结果的复核简报态（内存态，**不落域**）。
             *
             * 不落域有两层理由：它是 UI 文案不是档案数据（落进 userContext 就会
             * 经 upsertPersona 进宿主 persona_description、经 inject_persona 进
             * 此后每一轮对话）；而 persona 域的归一是逐字段重建，没在
             * normalizeUserContext 白名单登记的字段存进去也读不出来。
             */
            reviewBrief: REVIEW_BRIEF_NOT_RUN as ReviewBrief,
            /** 生成互斥与进度文案。 */
            isProcessing: false,
            processingLabel: '',
            /** 最近一次请求（重 roll 记忆）。 */
            lastRun: null as LastRunDescriptor | null,
            /** 参考分区：当前会话绑定书单（只读展示，全量注入）与问候语。 */
            boundBooks: [] as string[],
            greetings: [] as Array<{ label: string; content: string }>,
            selectedGreetingIndex: null as number | null,
        };
    },

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
        /**
         * 复核简报的展示态（四态文案在 strings.ts 的 TEXT.REVIEW_BRIEF）。
         *
         * 派生而非各处置一份文案：结果框被用户手改清空时 hasResult 为假，简报
         * 必须回到「未运行」——那一档描述的是结果框，空框上还挂着「已改写 N 个
         * 字段」是对着不存在的档案报账。
         */
        reviewBriefText(): string {
            return renderReviewBrief(this.hasResult ? this.reviewBrief : REVIEW_BRIEF_NOT_RUN);
        },
    },

    actions: {
        // ---------------- 初始化与宿主数据刷新 ----------------

        /** 模块初始化（浏览器/node 双流；幂等）。 */
        init() {
            this.loadFromDomain();
            this.refreshHostData();
            this.selectedGreetingIndex = this.greetings.length > 0 ? 0 : null;
        },

        /** 从全局域读快照进内存态（显式保存点之外的唯一读时机）。 */
        loadFromDomain() {
            const domain = readPersonaDomain();
            this.requestText = domain.userContext.request;
            this.resultText = domain.userContext.result;
            // 读回来的是上一会话落盘的结果，本会话没有复核过它——简报复位成
            // 未运行（域里根本没有这个字段，落盘的档案不带复核结论）。
            this.reviewBrief = REVIEW_BRIEF_NOT_RUN;
        },

        /**
         * 宿主派生数据刷新（init/onActivate 快照）：问候语/绑定书单。
         * 只读宿主，不写域。
         */
        refreshHostData() {
            this.greetings = getCharacterGreetingsList();
            this.boundBooks = getContextWorldBooks();
        },

        /**
         * CHAT_CHANGED 处理（订阅在 persona/index.ts init 挂载）：
         * lastRun 无条件清空（不跨会话携带——lastRun 里的 wiText 是旧会话
         * 快照，reroll 禁用直到新生成）；开场白重置为默认档（在场＝#0，
         * 显式「不注入」只保留到本聊天）；宿主派生快照无条件重拉
         * （读取廉价，指纹门控收益为零）。
         */
        handleChatChanged() {
            const fingerprintBefore = this.sessionFingerprint;
            this.lastRun = null;
            this.refreshHostData();
            // 重置须在快照重拉之后——默认档取决于新会话的 greetings
            this.selectedGreetingIndex = this.greetings.length > 0 ? 0 : null;
            if (this.sessionFingerprint !== fingerprintBefore) {
                log.info(`会话切换：指纹 ${fingerprintBefore} → ${this.sessionFingerprint}，宿主快照已重拉`);
            }
        },

        // ---------------- 显式保存点 ----------------

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

        // ---------------- 人设分区：生成/重 roll ----------------

        /** 生成（三轮链：策展→填充→复核）。互斥：isProcessing 期间静默忽略。 */
        async generate() {
            if (this.isProcessing) return;
            const api = buildApiConfig();
            if (!api) {
                toast(TEXT.TOAST_NO_ENDPOINT, 'error');
                return;
            }
            // 互斥先于 wiText 收集（异步窗口内二次点击不得重入）；取消通道
            // 同步建立——世界书收集段也在「停止」覆盖面内
            const controller = new AbortController();
            activeAbort = controller;
            this.isProcessing = true;
            this.processingLabel = '生成中…';
            try {
                const wiText = await collectWorldInfoContext();
                const run: LastRunDescriptor = {
                    request: this.requestText,
                    wiText,
                    greetingsText: this.selectedGreetingIndex !== null
                        ? (this.greetings[this.selectedGreetingIndex]?.content ?? '')
                        : '',
                };
                this.lastRun = run;
                await executeGeneration(this, run, api, undefined, controller.signal);
            } finally {
                this.isProcessing = false;
                this.processingLabel = '';
                activeAbort = null;
            }
        },

        /** 重 roll：只重放 lastRun 快照（wiText 不重收集）。 */
        async reroll() {
            if (this.isProcessing) return;
            if (!this.lastRun) {
                toast(TEXT.TOAST_NO_LAST_REQUEST, 'warning');
                return;
            }
            const api = buildApiConfig();
            if (!api) {
                toast(TEXT.TOAST_NO_ENDPOINT, 'error');
                return;
            }
            const controller = new AbortController();
            activeAbort = controller;
            try {
                await executeGeneration(this, this.lastRun, api, TEXT.TOAST_REROLLED, controller.signal);
            } finally {
                activeAbort = null;
            }
        },

        /** 取消进行中的生成（「停止」；无进行中请求时静默）。 */
        cancelGeneration() {
            activeAbort?.abort();
        },

        /** 清空（UI 层 confirm）。 */
        clearAll() {
            this.requestText = '';
            this.resultText = '';
            // 简报随结果一起复位：结果框空了，它描述的那份档案也不存在了，
            // 留着上一轮的「已改写 N 个字段」就是对着空框讲上一版的账。
            this.reviewBrief = REVIEW_BRIEF_NOT_RUN;
            this.lastRun = null;
            this.persistUserContext();
        },

        // ---------------- 落库 ----------------

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
    },
});
