/**
 * 运行日志 store（会话内存 ring）：choice/persona/summary 生成的统一观测面。
 *
 * 单一写入点＝共享传输层 callGenerateEndpoint（成功/失败全量记录），
 * 任务层只 enrich/markFailed 补解析结论。纯会话内存：不落盘、不进
 * extension_settings——跨重启留痕由 commit 内的 ttlog 摘要转发承担
 * （复用 nav/persona 已验证的宿主日志通道，正文不出会话）。
 */
import { defineStore } from 'pinia';
import { createTtlog } from '@/host/ttlog';
import type { RunRecord, RunTask } from './types';

export type { RunRecord, RunTask } from './types';

/** 会话内存环形上限（最旧记录被裁剪）。 */
const RING_MAX = 20;
/** 请求全文单条截断上限（组装 dump 体量大，防 UI/内存被单条拖垮）。 */
const REQUEST_MAX = 64 * 1024;
/** 响应全文单条截断上限。 */
const RESPONSE_MAX = 16 * 1024;
/** 失败摘要截断上限（错误展示面；诊断面另有 generator 500 字前缀）。 */
const ERROR_MAX = 300;
const TRUNCATED_SUFFIX = '«…已截断»';

const runlog = createTtlog('runlog');

function clip(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + TRUNCATED_SUFFIX : text;
}

interface RunRecordSummary {
    id: number;
    task: RunTask;
    model: string;
    ok: boolean;
    durationMs: number;
    parsePath?: string;
    optionCount?: number;
    dropped?: number;
    error?: string;
}

/** 路径＋丢弃数的括注（dropped 仅 partial enrich 后在场）。 */
function parseDetail(r: RunRecordSummary): string {
    if (r.parsePath === undefined) return '';
    return r.dropped !== undefined ? `${r.parsePath} 丢 ${r.dropped}` : r.parsePath;
}

/**
 * 摘要行（ttlog 3072 截断由转发器承担；遵守「不记消息正文」约定——
 * 摘要只含元数据，正文只在内存记录里）。
 */
function summaryLine(r: RunRecordSummary): string {
    if (!r.ok) {
        return `[tt-toolkit][runlog][${r.task}] run#${r.id} fail：${r.error ?? '（无错误摘要）'}`;
    }
    // choice 的条数/路径由任务层 enrich 补齐——enrich 未落地前 detail 留空；
    // partial 的丢弃数随路径一并可见（恢复成功不可见＝把问题藏起来）
    const paren = parseDetail(r);
    const detail = r.optionCount !== undefined ? `${r.optionCount} 条（${paren}）` : paren;
    const sec = (r.durationMs / 1000).toFixed(1);
    const tail = [detail, `${sec}s`, r.model].filter(p => p !== '').join(' ');
    return `[tt-toolkit][runlog][${r.task}] run#${r.id} ok：${tail}`;
}

export const useRunlogStore = defineStore('tt-runlog', {
    state: () => ({
        records: [] as RunRecord[],
        nextId: 1,
    }),
    actions: {
        /** 唯一落 ring 入口：裁剪正文＋推送摘要（console 与 ttlog 同一行文本）。 */
        commit(record: Omit<RunRecord, 'id'>): number {
            const full: RunRecord = {
                ...record,
                id: this.nextId++,
                requestText: clip(record.requestText, REQUEST_MAX),
                responseText: clip(record.responseText, RESPONSE_MAX),
                error: record.error !== undefined ? clip(record.error, ERROR_MAX) : undefined,
            };
            this.records.push(full);
            if (this.records.length > RING_MAX) {
                this.records.splice(0, this.records.length - RING_MAX);
            }
            this.emitSummary(full);
            return full.id;
        },
        /** choice 任务层补解析结论；摘要随最终态重发一行（同 run# 可对账）。 */
        enrich(id: number, patch: { parsePath?: string; optionCount?: number; dropped?: number }): void {
            const record = this.records.find(r => r.id === id);
            if (!record) return;
            if (patch.parsePath !== undefined) record.parsePath = patch.parsePath;
            if (patch.optionCount !== undefined) record.optionCount = patch.optionCount;
            if (patch.dropped !== undefined) record.dropped = patch.dropped;
            this.emitSummary(record);
        },
        /** 翻转最终态为失败并写摘要（传输已 commit 的记录由任务层二次定性）。 */
        markFailed(id: number, error: string): void {
            const record = this.records.find(r => r.id === id);
            if (!record) return;
            record.ok = false;
            record.error = clip(error, ERROR_MAX);
            this.emitSummary(record);
        },
        clear(): void {
            this.records = [];
        },
        emitSummary(record: RunRecord): void {
            // console 镜像归 ttlog 单点（ERROR/WARN 自带 console；INFO 只进
            // ring/文件——成功面的控制台可见性由 generator「生成完成」行承担，
            // 此处再 console 会令 fail 摘要在控制台双打）
            const line = summaryLine(record);
            if (record.ok) runlog.info(line);
            else runlog.error(line);
        },
    },
});
