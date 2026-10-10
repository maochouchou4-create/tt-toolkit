/**
 * 大小总结生成管线：守卫链（互斥/开关/算术/端点）→ 引擎组装 →
 * 统一端点请求 → 空白守门 → 隐藏楼层 → 落账 → 槽重挂 → 大总结级联。
 *
 * 取消边界（拍板）：abort 检查只存在于生成完成之前（fetch 层 signal）；
 * hide 步骤启动后的路径不可中断——「失败/取消不动任何楼层」承诺的成立
 * 边界就在 hide 之前：生成失败/取消时没有任何楼层与状态被改动，下次
 * 触发自然重试。
 *
 * quiet 楼层不滤（与 choice 相反）：总结按楼层计数，quiet 楼层也是剧情
 * 内容——过滤归事件守卫（接线层），生成管线只认 raw 楼层判据。
 */
import { getChatMessages, getTavernContext, isHostErrorText, type ChatMessage } from '@/host';
import { callGenerateEndpoint, isBlankResponseContent, type GenerateRequestConfig } from '@/modules/apis/client';
import { resolveActiveEndpoint } from '@/modules/apis/storage';
import { TASK_DEFAULTS } from '@/modules/apis/task-defaults';
import { assembleMessages, usePromptsStore } from '@/prompts';
import type { TaskKey } from '@/prompts';
import { planAutoSmallSummary, planManualSmallSummary, shouldRunBigSummary } from './arithmetic';
import { readSummaryChatState, readSummarySettings, writeSummaryChatState, clearSummaryChatState } from './settings';
import { clearSummarySlot, resyncSummarySlot } from './slot';
import { hideFloors, rawFloorIndices, restoreAllFloors } from './state';

/** 一次运行的结果（接线层按 kind 决定 toast／静默；node 冒烟按它机判）。 */
export type SummaryRunOutcome =
    | { kind: 'busy' }
    | { kind: 'skipped'; reason: string }
    | { kind: 'cancelled' }
    | { kind: 'failed'; message: string }
    | { kind: 'small-done'; foldedFloors: number; bigRan: boolean; bigError?: string }
    | { kind: 'big-done' };

/** 生成互斥锁（choice generator 同款：首个 await 前同步置位，fire-and-forget 无竞态窗口）。 */
let activeAbort: AbortController | null = null;

export function isSummaryRunning(): boolean {
    return activeAbort !== null;
}

export function cancelSummaryGeneration(): void {
    // 只发 abort 不清锁：真实网络下 abort 到 reject 有延迟，提前清锁会让
    // 新 run 与旧 run 短暂并存（互斥承诺被削弱）——旧 run 的 finally 收口。
    activeAbort?.abort();
}

/** 用户/角色名（speaker 标注用）：宿主 name1/name2 是聊天内 user/char 名的单一来源；缺席兜底空串。 */
function collectSpeakerNames(): { userName: string; charName: string } {
    const ctx = getTavernContext() as { name1?: unknown; name2?: unknown } | null;
    return { userName: String(ctx?.name1 ?? ''), charName: String(ctx?.name2 ?? '') };
}

/**
 * 小总结源文本：待压缩楼层逐楼 speaker 标注（【{speaker}】\n{mes.trim()}，
 * 楼间空行）。speaker＝is_user 取用户名，否则取楼层自带 name（群聊楼层
 * 各自带名，顺带兼容），再兜底角色名。不经引擎转发——summary 组装源
 * 只有 sourceText（该通道在引擎侧无占位符消费，是恒 no-op）。
 */
export function buildSmallSourceText(floors: ChatMessage[]): string {
    const names = collectSpeakerNames();
    return floors
        .map(m => {
            const speaker = m.is_user === true
                ? names.userName
                : (typeof m.name === 'string' && m.name ? m.name : names.charName);
            return `【${speaker}】\n${String(m.mes ?? '').trim()}`;
        })
        .join('\n\n');
}

/** 大总结源文本：旧大总结（缺席占位「（无）」）＋未折叠小总结群（时间序，空行分隔）。 */
export function buildBigSourceText(state: { bigSummary: string; smallSummaries: Array<{ text: string }> }): string {
    const smalls = state.smallSummaries.map(r => r.text.trim()).filter(Boolean).join('\n\n');
    return `=== 旧大总结 ===\n${state.bigSummary.trim() || '（无）'}\n\n=== 近期小总结（按时间先后）===\n${smalls}`;
}

/**
 * 单段总结生成（组装→请求）。任务参数固化在 TASK_DEFAULTS（temperature
 * 0.7 保真优先、reasoningEffort high 全任务同档；outputContract prompt_only
 * ——纯文本压缩无 JSON 契约）。端点缺席抛错（守卫链已先行归类 skipped，
 * 这里是 Fail Fast 兜底）。
 */
async function generateSummaryText(task: TaskKey, sourceText: string, signal: AbortSignal): Promise<string> {
    const endpoint = resolveActiveEndpoint();
    if (!endpoint) throw new Error('未选择生成端点');
    const config = usePromptsStore().configFor(task);
    if (!config) throw new Error(`提示词配置缺席（${task}——storage 未初始化？）`);
    const assembled = assembleMessages(config.modules, { sourceText });
    const requestConfig: GenerateRequestConfig = {
        task: 'summary',
        baseUrl: endpoint.url,
        apiKey: endpoint.key,
        model: endpoint.model,
        temperature: TASK_DEFAULTS.summaryTemperature,
        stream: TASK_DEFAULTS.stream,
        outputContract: 'prompt_only',
        reasoningEffort: TASK_DEFAULTS.summaryReasoningEffort,
    };
    const result = await callGenerateEndpoint(assembled.messages, requestConfig, signal);
    return result.content;
}

const NO_ENDPOINT_REASON = '未选择生成端点——到「API」页点端点条目上的「使用」按钮';
const NOTHING_TO_SUMMARIZE_REASON = '没有可总结的楼层（更早的楼层都在原文保留窗口内）';
const NOTHING_TO_MERGE_REASON = '没有未折叠的小总结，无需大总结';

/**
 * 小总结一段链。auto＝自动触发（受 autoEnabled 与间隔轮数门槛约束）；
 * 手动触发只要求 aged ≥ 2。成功路径：hide → 落账 → 重挂槽 → 级联检查。
 */
export async function runSmallSummary(options: { auto: boolean }): Promise<SummaryRunOutcome> {
    if (activeAbort) return { kind: 'busy' };
    const controller = new AbortController();
    activeAbort = controller;
    try {
        const settings = readSummarySettings();
        if (options.auto && !settings.autoEnabled) return { kind: 'skipped', reason: '自动总结未开启' };
        const rawIdx = rawFloorIndices();
        const plan = options.auto
            ? planAutoSmallSummary(rawIdx.length, settings.intervalRounds, settings.keepRounds)
            : planManualSmallSummary(rawIdx.length, settings.keepRounds);
        if (plan.batchSize < 2) {
            return { kind: 'skipped', reason: options.auto ? `算术不达标（aged ${plan.eatCount} 楼，间隔 ${settings.intervalRounds} 轮）` : NOTHING_TO_SUMMARIZE_REASON };
        }
        if (!resolveActiveEndpoint()) return { kind: 'skipped', reason: NO_ENDPOINT_REASON };
        const chat = getChatMessages();
        const targetIdx = rawIdx.slice(0, plan.batchSize).filter(i => typeof chat[i]?.mes === 'string');
        if (targetIdx.length < 2) return { kind: 'skipped', reason: NOTHING_TO_SUMMARIZE_REASON };
        // 源文本只取非宿主错误楼层：错误正文不是剧情，进摘要即产出「总结错误
        // 的假摘要」并经槽注入后续所有对话。错误楼层仍随批折叠（aged 垃圾
        // 楼不留存），只是不参与摘要内容——触发时机由 auto.ts 守卫拦在入口，
        // 这里管的是「早先落下的错误楼被后来某次批顺带扫进来」的存量面。
        const contentIdx = targetIdx.filter(i => !isHostErrorText(chat[i]?.mes));
        if (contentIdx.length < 2) return { kind: 'skipped', reason: NOTHING_TO_SUMMARIZE_REASON };
        const text = await generateSummaryText('summary_small', buildSmallSourceText(contentIdx.map(i => chat[i])), controller.signal);
        if (isBlankResponseContent(text)) return { kind: 'failed', message: '模型未返回任何内容（可能被上游静默拦截或思维链耗尽输出预算）' };
        // 生成完成瞬间的末次复查：CHAT_CHANGED abort 恰落在 fetch 已 resolve
        // 之后时，旧聊天的 hide/落账会作用到新聊天上（跨聊天串写）——
        // cancelled 提前退出，hide 之后才是不可中断区（取消边界拍板）。
        if (controller.signal.aborted) return { kind: 'cancelled' };
        // ——取消边界：hide 启动后以下路径不可中断（无 abort 检查）——
        hideFloors(targetIdx);
        const state = readSummaryChatState();
        state.smallSummaries.push({ text: text.trim(), fromFloor: targetIdx[0], toFloor: targetIdx[targetIdx.length - 1] });
        writeSummaryChatState(state);
        resyncSummarySlot();
        // 大总结级联（拍板：落账攒满 bigEvery 立即跑；同锁内串行——大总结
        // 失败不回滚已落账的小总结，下次触发按级联条件自然重试）
        let bigRan = false;
        let bigError: string | undefined;
        if (shouldRunBigSummary(state.smallSummaries.length, settings.bigEvery)) {
            const bigOutcome = await runBigSummaryLocked(controller.signal);
            bigRan = bigOutcome.kind === 'big-done';
            // 只透传 failed 的错误文案；cancelled/skipped 静默（取消无可见
            // 变更的纪律——「大总结失败：cancelled」是文案泄漏不是错误报告）
            if (!bigRan && bigOutcome.kind === 'failed') bigError = bigOutcome.message;
        }
        console.info(`[tt-toolkit][summary] 小总结完成：折叠 ${targetIdx.length} 楼${bigRan ? '，大总结已合并' : ''}`);
        return { kind: 'small-done', foldedFloors: targetIdx.length, bigRan, bigError };
    } catch (e) {
        if (controller.signal.aborted) return { kind: 'cancelled' };
        return { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
    } finally {
        if (activeAbort === controller) activeAbort = null;
    }
}

/** 大总结生成与替换（须持锁调用：公共入口先置互斥锁；级联复用同一条 abort 链）。 */
async function runBigSummaryLocked(signal: AbortSignal): Promise<SummaryRunOutcome> {
    const state = readSummaryChatState();
    if (state.smallSummaries.length === 0) return { kind: 'skipped', reason: NOTHING_TO_MERGE_REASON };
    const text = await generateSummaryText('summary_big', buildBigSourceText(state), signal);
    if (isBlankResponseContent(text)) return { kind: 'failed', message: '模型未返回任何内容（可能被上游静默拦截或思维链耗尽输出预算）' };
    // 生成完成瞬间的末次复查（同小总结：abort 落在 resolve 后时不得写新聊天）
    if (signal.aborted) return { kind: 'cancelled' };
    // ——取消边界：替换路径不可中断——重新读态防生成期间漂移
    const next = readSummaryChatState();
    next.bigSummary = text.trim();
    next.smallSummaries = [];
    writeSummaryChatState(next);
    resyncSummarySlot();
    return { kind: 'big-done' };
}

/** 手动大总结：未折叠小总结群整体合并（旧大总结滚动并入新文）。 */
export async function runBigSummary(): Promise<SummaryRunOutcome> {
    if (activeAbort) return { kind: 'busy' };
    const controller = new AbortController();
    activeAbort = controller;
    try {
        if (!resolveActiveEndpoint()) return { kind: 'skipped', reason: NO_ENDPOINT_REASON };
        return await runBigSummaryLocked(controller.signal);
    } catch (e) {
        if (controller.signal.aborted) return { kind: 'cancelled' };
        return { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
    } finally {
        if (activeAbort === controller) activeAbort = null;
    }
}

/**
 * 还原全部：flag 楼层翻回＋chat 域总结态清空＋清槽（完整可逆）。运行中
 * 拒绝——两段确认窗内新回复可触发自动总结，in-flight 成功路径会静默
 * 覆盖还原结果（拒绝的 toast 文案归接线层，此处只给 kind）。
 */
export function restoreAllSummaries(): { kind: 'busy' } | { kind: 'restored'; floors: number } {
    if (activeAbort) return { kind: 'busy' };
    const floors = restoreAllFloors();
    clearSummaryChatState();
    clearSummarySlot();
    return { kind: 'restored', floors };
}
