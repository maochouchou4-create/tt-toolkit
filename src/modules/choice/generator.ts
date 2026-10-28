/**
 * 选项生成管线：组装（引擎）→ 请求（统一端点表＋共享客户端）
 * → 解析（response_format 主路径＋客户端兜底）→ 落档（该楼消息 extra）。
 *
 * 组装结果（消息数组＋trace）每次生成后进 dump 设施——用户靠它核对
 * 各注入模块逐项可见。
 */
import { getChatMessages, getSendTextareaValue, sendInputMessage, setSendTextareaValue, showToast, type ChatMessage } from '@/host';
import { callGenerateEndpoint, isBlankResponseContent, RequestTimeoutError, serializeOutbound, type GenerateMessage, type GenerateRequestConfig } from '@/modules/apis/client';
import { missingTaskModelError, resolveTaskRoute, routeToRequestConfig } from '@/modules/apis/task-profiles';
import { TASK_PARAMS } from '@/modules/apis/task-defaults';
import { resolveJailbreakMessages } from '@/modules/apis/preset-inject';
import {
    assembleMessages,
    collectAssemblySources,
    renderDump,
    DEFAULT_PROMPT_CONFIGS,
    type PoolInjectionSupply,
} from '@/prompts';
import type { ModuleTrace } from '@/prompts';
import { useRunlogStore } from '@/modules/runlog/store';
import { choiceStorage } from './api';
import { useStoryDirectionStore } from './direction';
import { DEBUG_MALFORMED_RAW, parseOptions, type ParseReport } from './parse';
import { clearFloorOptions, latestAssistantFloorIndex } from './persist';
import { drawPoolInjection } from './pool/storage';
import { useChoiceStore } from './store';

/** 外部取消信号（导航「生成」键在生成中再执行＝取消）。锁由轮次持有：
 *  cancel 只 abort，释放唯一归 finally —— 同步清锁会让旧轮收尾覆盖新轮
 *  相位（取消后立刻再起＝并发互斥破防）。 */
let activeAbort: AbortController | null = null;

export function cancelGeneration(): void {
    activeAbort?.abort();
}

export function isGenerating(): boolean {
    return activeAbort !== null;
}

/**
 * 导航「生成」键与 /tt-choice-gen 斜令的统一 toggle：生成中再执行＝取消；
 * 无锚楼＝提示后不动（生成恒锚起点末条 assistant 楼，语义不变）；空闲＝
 * 启动生成。返回是否已进入生成（命令侧不消费返回值，冒烟据此判两段式）。
 */
export function toggleChoiceGeneration(): boolean {
    if (isGenerating()) {
        cancelGeneration();
        return false;
    }
    if (latestAssistantFloorIndex() === null) {
        showToast('当前聊天没有可挂选项的回复楼层', 'warning');
        return false;
    }
    void generateOptions();
    return true;
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
    const config = DEFAULT_PROMPT_CONFIGS.choice;
    const gen = choiceStorage.readDomain().gen;
    const poolInjection: PoolInjectionSupply = drawPoolInjection();
    const sources = await collectAssemblySources({
        storyDirection: useStoryDirectionStore().storyDirection,
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
 * 生成请求带任务固化超时（TASK_PARAMS.choice.timeoutSec）——到点按失败
 * 可见报出（错误态＋toast＋runlog），与「用户按了取消」分开归类。
 * 调试开关 debugForceRaw 开启时跳过 API，用固定畸形样本走解析路径
 * （回退路径可确定性触发——debugForceRaw 判据载体）。
 */
export async function generateOptions(): Promise<void> {
    const store = useChoiceStore();
    if (activeAbort) return;
    const controller = new AbortController();
    activeAbort = controller;

    // 生成开始即清锚楼旧存档（重 roll/重新生成后旧选项作废），并按同一
    // 锚定把「状态行归属」写进 store——状态只画在生成起点锚楼，不随末楼
    // 漂移（不再有展示副本需要同步装载）
    const { anchorIndex, anchorMessage } = beginGenerationCycle();
    store.beginGenerate({ floorIndex: anchorIndex, floorMessage: anchorMessage });
    // runlog 接线：runId＝enrich/markFailed 目标；handedToClient＝调用 client
    // 前置 true——client 一经调用，本轮失败记录权归传输层（防同次失败双记：
    // client 抛错时 generator 拿不到 runId，null 判据会误判成「未发出」）
    const runlogStore = useRunlogStore();
    let runId: number | null = null;
    let handedToClient = false;
    let pendingMessages: GenerateMessage[] | null = null; // 组装成功即存：哨兵预览惰性取用（正常路径零额外序列化）
    try {
        const gen = choiceStorage.readDomain().gen;
        // 输出契约日志口径随常量（契约按任务固化，两分支同值）
        const outputContract: GenerateRequestConfig['outputContract'] = TASK_PARAMS.choice.outputContract;
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
            // 任务路由单点解析：未配置/悬空 fail fast，文案指路任务模型卡
            const route = resolveTaskRoute('choice');
            if (!route) throw missingTaskModelError('choice');
            const requestConfig = routeToRequestConfig('choice', route);
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
        const stored = store.succeed({
            options: report.options,
            dropped: report.dropped,
            dump: assembly.dumpText,
            floorIndex: anchorIndex,
            floorMessage: anchorMessage,
        });
        // 落档失败＝该楼在生成期间被删/被换（索引处已不是生成起点消息）：
        // 不能静默留在「成功」相位——界面没有任何块可画，用户会以为选项丢了
        if (!stored) {
            store.fail('选项未能落到该楼层（楼层已变化）');
            showToast('选项未能落到该楼层（楼层已变化）', 'error');
        }
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
        // 超时不是取消：传输层到点中止后抛的是 RequestTimeoutError（错误文案
        // 与 runlog 记录都由它带），而 signal.aborted 对「用户按了取消」与
        // 「端点没响应」同真——只认它会把超时静默报成「已取消」，用户看着像
        // 自己手滑按了取消，而这次失败没给他任何可追的线索。
        // 所有权判等：只有仍持有锁的本轮才能写相位——旧轮收尾不得覆盖新轮。
        const ownsLock = activeAbort === controller;
        if (controller.signal.aborted && !(e instanceof RequestTimeoutError)) {
            if (ownsLock) store.fail('已取消');
        } else {
            const message = e instanceof Error ? e.message : String(e);
            if (ownsLock) {
                store.fail(message);
                // 失败表面化（persona/nav 同款纪律）：锚楼错误行＋toast＋console 各司其职
                showToast(`选项生成失败：${message}`, 'error');
            }
            console.error('[tt-toolkit][choice] 生成失败', e);
        }
    } finally {
        // 锁释放唯一出口：只有锁仍归本轮时才置空（cancel 不再同步清锁）
        if (activeAbort === controller) activeAbort = null;
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
