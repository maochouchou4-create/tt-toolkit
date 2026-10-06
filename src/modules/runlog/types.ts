/**
 * 运行日志记录契约（choice/persona 共用的生成可观测性面）。
 *
 * 会话内存口径：不落盘、不进 extension_settings（跨重启留痕由 commit
 * 内的 ttlog 摘要转发承担，正文只活在内存 ring 里）。
 */

/** 生成任务归属（观测点在共享传输层，按任务区分摘要与 enrich 权）。 */
export type RunTask = 'choice' | 'persona';

export interface RunRecord {
    /** 自增，会话内唯一 */
    id: number;
    /** ISO 时间戳 */
    at: string;
    task: RunTask;
    /** baseUrl 归一后；apiKey 绝不进记录 */
    endpointUrl: string;
    model: string;
    /** OutputContract 字面量——本模块不 import apis（防环），仅存字符串 */
    contract: string;
    stream: boolean;
    durationMs: number;
    /** 该次生成最终是否产出可用结果（传输失败与任务层失败同字段同值域） */
    ok: boolean;
    /** messages 按「[role]\ncontent」空行分段序列化；超长截断加尾标 */
    requestText: string;
    /** 超长截断加尾标；未发请求为空串 */
    responseText: string;
    /** choice 任务 enrich */
    parsePath?: string;
    /** choice 任务 enrich */
    optionCount?: number;
    /** 失败摘要（safeText，300 字内） */
    error?: string;
}
