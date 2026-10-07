/**
 * 大小总结存储域（extension_settings.ttToolkit.summary ＋ chat_metadata.ttToolkit.summary）。
 *
 * 两域分工：
 *   - 全局域＝总结设置（开关＋节奏参数；跨聊天复用）；
 *   - 聊天域＝当前聊天的总结态（小总结群＋大总结正文＋覆盖计数）。
 * 被隐藏楼层的标记不落本域：单一事实源在各楼 message.extra.ttToolkit.summaryHidden
 * （纯数据 boolean，structuredClone 安全），hiddenCount 一律派生不落第二份。
 *
 * normalize 纪律同 choice/api.ts 先例：读侧合并缺省＋类型校验＋值域钳制；
 * 写侧落盘前统一归一化（导入/备份等绕过读通道的写入路径同样被防线覆盖）。
 */

import { getChat, getGlobal, setChat, setGlobal } from '@/storage';

/** 全局域总结设置键（extension_settings.ttToolkit 下；字面量仅此一份）。 */
export const GLOBAL_SUMMARY_KEY = 'summary';

/** 聊天域总结态键（chat_metadata.ttToolkit 下；字面量仅此一份）。 */
export const CHAT_SUMMARY_KEY = 'summary';

export interface SummarySettings {
    /** 自动总结总开关（默认 false） */
    autoEnabled: boolean;
    /** 小总结间隔轮数（默认 3，钳制 1-20；一轮＝一问一答两楼） */
    intervalRounds: number;
    /** 原文保留轮数（默认 3，钳制 1-20；最近 N 轮不总结） */
    keepRounds: number;
    /** 大总结攒批数（默认 3，钳制 2-10；未折叠小总结满 N 条触发） */
    bigEvery: number;
}

/** 单条小总结（聊天域 smallSummaries 元素）。 */
export interface SmallSummaryRecord {
    /** 小总结正文 */
    text: string;
    /** 记录时刻的楼层区间（0 基绝对索引；display-only，删楼后允许漂移不修 */
    fromFloor: number;
    toFloor: number;
}

export interface SummaryChatState {
    /** 未折叠进大总结的小总结（时间序） */
    smallSummaries: SmallSummaryRecord[];
    /** 当前大总结正文（空串＝尚无） */
    bigSummary: string;
    /** 大总结已覆盖的楼层数（含已折叠的小总结区间；加载时钳制 ≤ flagCount） */
    bigCoveredCount: number;
}

export const DEFAULT_SUMMARY_SETTINGS: SummarySettings = {
    autoEnabled: false,
    intervalRounds: 3,
    keepRounds: 3,
    bigEvery: 3,
};

/** 整数钳制：非有限数回退缺省；越界值钳回合法域（旧存档值不可信）。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
}

function isSmallSummaryRecord(value: unknown): value is SmallSummaryRecord {
    if (!value || typeof value !== 'object') return false;
    const r = value as Record<string, unknown>;
    return typeof r.text === 'string'
        && typeof r.fromFloor === 'number' && Number.isFinite(r.fromFloor)
        && typeof r.toFloor === 'number' && Number.isFinite(r.toFloor);
}

/** 总结设置归一（纯函数：坏值钳回合法域，缺字段补默认）。 */
export function normalizeSummarySettings(raw: unknown): SummarySettings {
    const record = (raw ?? {}) as Partial<Record<keyof SummarySettings, unknown>>;
    return {
        autoEnabled: record.autoEnabled === true,
        intervalRounds: clampInt(record.intervalRounds, 1, 20, DEFAULT_SUMMARY_SETTINGS.intervalRounds),
        keepRounds: clampInt(record.keepRounds, 1, 20, DEFAULT_SUMMARY_SETTINGS.keepRounds),
        bigEvery: clampInt(record.bigEvery, 2, 10, DEFAULT_SUMMARY_SETTINGS.bigEvery),
    };
}

/** 总结聊天态归一（纯函数：非数组/坏条目剔除，形状守门）。 */
export function normalizeSummaryChatState(raw: unknown): SummaryChatState {
    if (!raw || typeof raw !== 'object') return { smallSummaries: [], bigSummary: '', bigCoveredCount: 0 };
    const record = raw as Record<string, unknown>;
    return {
        smallSummaries: Array.isArray(record.smallSummaries)
            ? record.smallSummaries.filter(isSmallSummaryRecord)
            : [],
        bigSummary: typeof record.bigSummary === 'string' ? record.bigSummary : '',
        bigCoveredCount: clampInt(record.bigCoveredCount, 0, Number.MAX_SAFE_INTEGER, 0),
    };
}

/** 读总结设置（读侧归一；返回值与存储单例解耦）。 */
export function readSummarySettings(): SummarySettings {
    return normalizeSummarySettings(getGlobal<unknown>(GLOBAL_SUMMARY_KEY));
}

/** 写总结设置单通道（写侧再归一：坏值不经写通道持久化）。 */
export function writeSummarySettings(settings: SummarySettings): void {
    setGlobal(GLOBAL_SUMMARY_KEY, normalizeSummarySettings(settings));
}

/** 读当前聊天总结态（读侧归一；返回值与存储单例解耦）。 */
export function readSummaryChatState(): SummaryChatState {
    return normalizeSummaryChatState(getChat<unknown>(CHAT_SUMMARY_KEY));
}

/** 写当前聊天总结态单通道（写侧再归一）。 */
export function writeSummaryChatState(state: SummaryChatState): void {
    setChat(CHAT_SUMMARY_KEY, normalizeSummaryChatState(state));
}
