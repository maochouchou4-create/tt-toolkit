/**
 * 选项生成管线：组装（引擎）→ 请求（统一端点表＋共享客户端）
 * → 解析（response_format 主路径＋客户端兜底）→ 渲染（store 会话态）。
 *
 * 组装结果（消息数组＋trace）每次生成后进 dump 设施——用户靠它核对
 * 各注入模块逐项可见。
 */
import { getChatMessages, getSendTextareaValue, sendInputMessage, setSendTextareaValue, showToast, type ChatMessage } from '@/host';
import { callGenerateEndpoint, isBlankResponseContent, serializeOutbound, type GenerateMessage, type GenerateRequestConfig } from '@/modules/apis/client';
import { TASK_DEFAULTS } from '@/modules/apis/task-defaults';
import { resolveJailbreakMessages } from '@/modules/apis/preset-inject';
import {
    assembleMessages,
    collectAssemblySources,
    renderDump,
    usePromptsStore,
    type PoolInjectionSupply,
} from '@/prompts';
import type { ModuleTrace } from '@/prompts';
import { useRunlogStore } from '@/modules/runlog/store';
import { choiceStorage, resolveChoiceEndpoint } from './api';
import { useStoryDirectionStore } from './direction';
import { DEBUG_MALFORMED_RAW, parseOptions, type ParseReport } from './parse';
import { clearFloorOptions, latestAssistantFloorIndex } from './persist';
import { drawPoolInjection } from './pool/storage';
import { useChoiceStore } from './store';

/** 外部取消信号（选项条「取消」按钮）。 */
let activeAbort: AbortController | null = null;

export function cancelGeneration(): void {
    activeAbort?.abort();
    activeAbort = null;
}

export function isGenerating(): boolean {
    return activeAbort !== null;
}

/**
 * 0 条选项的失败文案：区分「模型压根没说话」与「说了话但抽不出选项」。
 *
 * 判据必须是「正文是否为空」而非「path 是否为 empty」——path 只回答
 * 「有没有抽出选项」，抽不出时一律归 empty，但导致抽不出的原因里既有
 * 真空响应，也有纯散文／拒答语／空数组等「模型其实有输出」的形态；
 * 只看 path 会把后者误报成「模型未返回任何内容」并抹掉原文，用户既被
 * 指错方向又看不到模型到底说了什么（两者是不同的信息，不是同一事实的
 * 两份来源）。
 *
 * - 正文为空＝上游静默拦截、或思维链耗尽输出预算（finish_reason 还可能
 *   谎报 stop）——空前缀无信息量，文案直接指向重试/换端点；
 * - 正文非空＝模型有输出但抽不出选项——保留原文前缀 500 诊断面（坏 JSON
 *   骸骨、拒答语、纯散文都靠它定位）。
 */
export function zeroOptionsMessage(report: ParseReport, rawText: string): string {
    if (isBlankResponseContent(rawText)) {
        return '模型未返回任何内容（0 条选项）：可能被上游静默拦截，或思维链耗尽了输出预算（finish_reason 显示 stop 也不可信）——可直接重试，或更换端点后再试。';
    }
    return `解析得到 0 条选项（路径 ${report.path}）——原始输出：${rawText.slice(0, 500)}`;
}

/**
 * 生成周期起点：锚定当前末条 assistant 楼层并立即清该楼旧选项存档。
 *
 * 清档必须在本仓侧主动做：宿主 clearMessageData 是白名单删除（不碰
 * extra.ttToolkit）且普通 regenerate 不调——旧选项会在重 roll 后存活
 * 并被 structuredClone 传染进新 swipe 槽，不能依赖宿主清理。
 * 生成失败时该楼保持「无选项」态（正确：旧选项随正文作废）；取消
 * （abort）只走复位分支、不写盘。
 * 导出仅供冒烟直调断言「生成开始即清档」（浏览器路径经 generateOptions）。
 */
export function beginGenerationCycle(): { anchorIndex: number | null; anchorMessage: ChatMessage | null } {
    const anchorIndex = latestAssistantFloorIndex();
    const anchorMessage = anchorIndex !== null ? getChatMessages()[anchorIndex] : null;
    if (anchorIndex !== null) {
        clearFloorOptions(anchorIndex, anchorMessage);
    }
    return { anchorIndex, anchorMessage };
}

/**
 * 组装当前上下文的消息数组（dump 口与生成管线共用一条路径）。
 * 观测面口径：dumpText 的消息段＝实发序列（破限前缀＋组装，前缀经
 * apis/preset-inject 的 composeOutbound 同一实现，与运行日志 requestText
 * 的前缀层同源）；`messages` 字段＝传输前序列（传输层在此之上补前缀）。
 * 尾部闲聊/传输前缀等「契约之外的内容」见 parse.ts 的尾部分流判据。
 *
 * 池供给在这里现场抽取（每次组装重抽、pinned 恒在）——抽一次快照
 * 传给 sources/engine，prompts 层不回读 choice 域（单向供给）。
 */
export async function assembleCurrent(): Promise<{ dumpText: string; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; trace: ModuleTrace[] }> {
    const promptsStore = usePromptsStore();
    const config = promptsStore.effectiveConfig;
    if (!config) throw new Error('提示词配置缺席（storage 未初始化？）');
    const gen = choiceStorage.readDomain().gen;
    const poolInjection: PoolInjectionSupply = drawPoolInjection();
    const sources = await collectAssemblySources({
        storyDirection: useStoryDirectionStore().storyDirection,
        contextRounds: gen.contextRounds,
        count: gen.count,
        minChars: gen.minChars,
        maxChars: gen.maxChars,
        poolInjection,
    });
    const result = assembleMessages(config.modules, sources);
    return { dumpText: renderDump(result, undefined, resolveJailbreakMessages()), messages: result.messages, trace: result.trace };
}

/**
 * 生成一次行动选项（全流程）。生成中重复调用拒绝（防并发重入）。
 * 调试开关 debugForceRaw 开启时跳过 API，用固定畸形样本走解析路径
 * （回退路径可确定性触发——debugForceRaw 判据载体）。
 */
export async function generateOptions(): Promise<void> {
    const store = useChoiceStore();
    if (activeAbort) return;
    const controller = new AbortController();
    activeAbort = controller;

    store.beginGenerate();
    // 生成开始即清锚楼旧存档（重 roll/重新生成后旧选项作废）并按新锚楼
    // 复位展示态——不得走 clearOptions（会把上一楼层仍合法的存档一并清掉）
    const { anchorIndex, anchorMessage } = beginGenerationCycle();
    store.syncToFloor(anchorIndex);
    // runlog 接线：runId＝enrich/markFailed 目标；handedToClient＝调用 client
    // 前置 true——client 一经调用，本轮失败记录权归传输层（防同次失败双记：
    // client 抛错时 generator 拿不到 runId，null 判据会误判成「未发出」）
    const runlogStore = useRunlogStore();
    let runId: number | null = null;
    let handedToClient = false;
    let pendingMessages: GenerateMessage[] | null = null; // 组装成功即存：哨兵预览惰性取用（正常路径零额外序列化）
    try {
        const gen = choiceStorage.readDomain().gen;
        // 输出契约日志口径随常量（任务参数固化，两分支同值）
        const outputContract: GenerateRequestConfig['outputContract'] = TASK_DEFAULTS.choiceOutputContract;
        let rawText: string;
        const assembly = await assembleCurrent();
        store.lastDump = assembly.dumpText;
        pendingMessages = assembly.messages;

        if (gen.debugForceRaw) {
            rawText = DEBUG_MALFORMED_RAW;
            runId = runlogStore.commit({
                at: new Date().toISOString(),
                task: 'choice',
                endpointUrl: '(debugForceRaw)',
                model: '(debugForceRaw)',
                contract: outputContract,
                stream: false,
                durationMs: 0,
                ok: true,
                requestText: serializeOutbound(pendingMessages),
                responseText: DEBUG_MALFORMED_RAW,
            });
        } else {
            const endpoint = resolveChoiceEndpoint();
            if (!endpoint) {
                throw new Error('未选择生成端点——到「API」页点端点条目上的「使用」按钮');
            }
            // 任务参数固化（TASK_DEFAULTS 单一真相源；用户面零旋钮）
            const requestConfig: GenerateRequestConfig = {
                task: 'choice',
                baseUrl: endpoint.url,
                apiKey: endpoint.key,
                model: endpoint.model,
                temperature: TASK_DEFAULTS.temperature,
                stream: TASK_DEFAULTS.stream,
                outputContract: TASK_DEFAULTS.choiceOutputContract,
                reasoningEffort: TASK_DEFAULTS.reasoningEffort,
            };
            handedToClient = true;
            const result = await callGenerateEndpoint(assembly.messages, requestConfig, controller.signal);
            rawText = result.content;
            runId = result.runId;
        }

        const report = parseOptions(rawText, gen.count);
        if (report.options.length === 0) {
            const message = zeroOptionsMessage(report, rawText);
            if (runId !== null) runlogStore.markFailed(runId, message);
            throw new Error(message);
        }
        if (runId !== null) {
            runlogStore.enrich(runId, { parsePath: report.path, optionCount: report.options.length, dropped: report.dropped });
        }
        store.succeed({
            options: report.options,
            parsePath: report.path,
            dropped: report.dropped,
            dump: assembly.dumpText,
            floorIndex: anchorIndex,
            floorMessage: anchorMessage,
        });
        // dump 落 console 一份：控制台即排障口（与 __TT_TOOLKIT__.prompts.dump 同源）
        console.info(`[tt-toolkit][choice] 生成完成：${report.options.length} 条（解析路径=${report.path}，输出契约=${outputContract}）`);
    } catch (e) {
        // 哨兵补记：仅「请求未发出」（端点缺失/组装抛错）时——client 抛错
        // （含取消）已由传输层记录，再补即双记
        if (runId === null && !handedToClient) {
            const message = e instanceof Error ? e.message : String(e);
            runlogStore.commit({
                at: new Date().toISOString(),
                task: 'choice',
                endpointUrl: '(未发出)',
                model: '',
                contract: 'prompt_only',
                stream: false,
                durationMs: 0,
                ok: false,
                requestText: pendingMessages ? serializeOutbound(pendingMessages) : '',
                responseText: '',
                error: message,
            });
        }
        if (controller.signal.aborted) {
            store.fail('已取消');
        } else {
            const message = e instanceof Error ? e.message : String(e);
            store.fail(message);
            // 失败表面化（persona/nav 同款纪律）：选项条错误态＋toast＋console 各司其职
            showToast(`选项生成失败：${message}`, 'error');
            console.error('[tt-toolkit][choice] 生成失败', e);
        }
    } finally {
        activeAbort = null;
    }
}

/** 点击行为应用：fill 覆盖填入 / append 追加 / send 直接发送。 */
export function applyOption(content: string): void {
    const gen = choiceStorage.readDomain().gen;
    const behavior = gen.clickBehavior;
    if (behavior === 'send') {
        // 发送：填入后立即触发宿主发送通道；发送失败恢复输入内容
        void setAndSend(content);
        return;
    }
    if (behavior === 'append') {
        // 追加＝读当前值＋整体写回：textarea 的取值/赋值（含 input 事件
        // 派发）已封装在 host/chat——选择器逻辑不在业务侧重复第二份
        setSendTextareaValue(getSendTextareaValue() + content);
        return;
    }
    setSendTextareaValue(content);
}

async function setAndSend(content: string): Promise<void> {
    setSendTextareaValue(content);
    try {
        await sendInputMessage();
    } catch (e) {
        // 发送被拦截/失败：恢复为纯正文，不留半截状态
        setSendTextareaValue(content);
        console.error('[tt-toolkit][choice] 发送失败', e);
    }
}
