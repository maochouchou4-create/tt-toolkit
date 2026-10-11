/**
 * 事件感知总结的判断器（adaptive 模式区间内问模型「现在值不值得总结」）。
 *
 * 请求形态：system＝提示词引擎 summary_judge 任务模板（好/坏时机对照式），
 * user＝运行时拼装的窗口上下文（距上次总结楼数＋最近若干层楼层文本，
 * 「【说话人】正文」形态与总结源文本同构——判断与总结看同一种剧情）。
 * 出站走任务路由 summary_judge（服务 flash 级模型的档案行）；破限前缀
 * 不进判断请求（composeOutbound 按任务豁免，元任务不污染判断基准）。
 *
 * 失败面全部按「判 null」收口（自动路径静默纪律：不 toast 打扰、不重试
 * 硬砸；runlog 已有失败记录，console 留线索供排障）。无互斥锁、无
 * abort——轻请求无副作用，判断通过后的真正总结走 runSmallSummary 既有锁。
 */
import { getChatMessages, isHostErrorText, type ChatMessage } from '@/host';
import { callGenerateEndpoint, isBlankResponseContent } from '@/modules/apis/client';
import { TASK_PARAMS } from '@/modules/apis/task-defaults';
import { resolveTaskRoute } from '@/modules/apis/task-profiles';
import { assembleMessages, usePromptsStore } from '@/prompts';
import { buildSmallSourceText } from './generator';
import { rawFloorIndices } from './state';

/** 判断上下文窗口：距上次总结的最近 N 层 raw 楼层。 */
export const JUDGE_CONTEXT = 6;

export type SummaryJudgeResult =
    | { kind: 'unconfigured' }
    | { kind: 'judged'; /** true＝建议总结；false＝不建议；null＝解析失败（本轮放弃，不重试） */ shouldSummarize: boolean | null; /** 模型理由（解析失败＝空串） */ reason: string };

const SHOULD_SUMMARIZE_RE = /"should_summarize"\s*:\s*(true|false)/;

/**
 * 判断响应解析三级（导出仅供冒烟直测）：①整体 JSON 且 should_summarize
 * 为 boolean → 采信；②退正则首个命中（宽松文本里嵌 JSON 的形态）；
 * ③都失败 → null。理由字段只在①级解析成功且为 string 时透传。
 */
export function parseJudgeResponse(content: string): { shouldSummarize: boolean | null; reason: string } {
    try {
        const parsed = JSON.parse(content) as { should_summarize?: unknown; reason?: unknown };
        if (typeof parsed.should_summarize === 'boolean') {
            return { shouldSummarize: parsed.should_summarize, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
        }
    } catch {
        // 非 JSON 正文——退正则分级
    }
    const match = SHOULD_SUMMARIZE_RE.exec(content);
    if (match) return { shouldSummarize: match[1] === 'true', reason: '' };
    return { shouldSummarize: null, reason: '' };
}

/**
 * 发一次总结时机判断。窗口楼层与总结源文本同口径过滤宿主错误正文
 * （错误楼不是剧情，进窗口会误导段落节点判断）；过滤后窗口为空＝没有
 * 可判的剧情，直接判 null 不发请求。
 */
export async function runSummaryJudge(): Promise<SummaryJudgeResult> {
    const route = resolveTaskRoute('summary_judge');
    if (!route) {
        console.warn('[tt-toolkit][summary] 判断模型未配置——到「API」页「任务模型」卡给「总结判断」配置服务商与模型');
        return { kind: 'unconfigured' };
    }
    const chat = getChatMessages();
    const rawIdx = rawFloorIndices();
    const windowIdx = rawIdx.slice(-JUDGE_CONTEXT).filter(i => !isHostErrorText(chat[i]?.mes));
    const windowText = buildSmallSourceText(windowIdx.map(i => chat[i] as ChatMessage));
    if (windowText.trim() === '') return { kind: 'judged', shouldSummarize: null, reason: '' };
    const sourceText = `${rawIdx.length} messages have passed since the last summary. The most recent messages:\n\n${windowText}\n\nDecide whether now is a good moment to compile a story summary.`;
    const config = usePromptsStore().configFor('summary_judge');
    if (!config) {
        console.warn('[tt-toolkit][summary] 判断提示词配置缺席（storage 未初始化？）——按判否处理');
        return { kind: 'judged', shouldSummarize: null, reason: '' };
    }
    const assembled = assembleMessages(config.modules, { sourceText });
    try {
        const result = await callGenerateEndpoint(assembled.messages, {
            task: 'summary_judge',
            baseUrl: route.url,
            apiKey: route.key,
            model: route.model,
            temperature: route.temperature,
            stream: TASK_PARAMS.summary_judge.stream,
            outputContract: TASK_PARAMS.summary_judge.outputContract,
            reasoningEffort: route.reasoningEffort,
        });
        if (isBlankResponseContent(result.content)) {
            console.warn('[tt-toolkit][summary] 判断响应为空白——按判否处理（不重试）');
            return { kind: 'judged', shouldSummarize: null, reason: '' };
        }
        const parsed = parseJudgeResponse(result.content);
        if (parsed.shouldSummarize === null) {
            console.warn(`[tt-toolkit][summary] 判断响应无法解析——按判否处理（不重试）：${result.content.slice(0, 120)}`);
        }
        return { kind: 'judged', ...parsed };
    } catch (e) {
        console.warn(`[tt-toolkit][summary] 判断请求失败——按判否处理（不重试）：${e instanceof Error ? e.message : String(e)}`);
        return { kind: 'judged', shouldSummarize: null, reason: '' };
    }
}
