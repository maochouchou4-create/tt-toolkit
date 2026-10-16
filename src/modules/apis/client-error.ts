/**
 * 生成响应的错误契约（流式与非流式共用的唯一判据出口）。
 *
 * 两处消费：SSE 帧解析（client-sse.ts 的帧级错误判定）与非流式响应体解析
 * （client.ts）。两出口各写一份判断时 `{"error":""}` 会一边抛错一边放行，
 * 所以判据与文案提取必须同处本模块，由两条路径共用。
 */

/**
 * 上游错误对象的文案提取（readUpstreamError 的内层）。
 * 三档有真实帧样本背书（llm-api-3158：帧级 `code` 是字符串 slug
 * `invalid_argument`，状态码只在 message 正文里）——不从 message 正则
 * 刮状态码：那是把文本嗅探搬进传输层，需要 400 家族判据的消费方
 * （persona 的 prefill 重试）自己按 message 文本判。
 *
 * 字符串形态单独一档：OpenAI 旧形态与部分网关直接给字符串，落进
 * JSON.stringify 会产出带引号的字面文本（`"\"Bad request\""`）并把换行
 * 转义成 \n——那是展示垃圾，且会污染消费方的文本判据。
 */
function extractErrorText(error: unknown): string {
    if (typeof error === 'string') return error;
    const message = (error as { message?: unknown } | null | undefined)?.message;
    if (typeof message === 'string' && message !== '') return message;
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && code !== '') return code;
    // 调用方已拦掉 null/undefined，JSON.parse 的产物不会是 function/symbol，
    // 故此处 stringify 恒返字符串（不再兜一条不可达的 ?? 分支）
    return JSON.stringify(error);
}

/**
 * 「上游 error 键」契约的唯一出口：判据与文案提取同处一个函数，流式帧与
 * 非流式响应各写一份判断时，`{"error":""}` 会一边抛错一边放行。
 * null/undefined 不算错误（部分上游的正常帧带 `error: null` 键）；0/'' 这类
 * falsy 算错误——上游不会挂着 error 键表达成功。
 */
export function readUpstreamError(payload: { error?: unknown } | null | undefined): string | null {
    if (payload?.error == null) return null;
    return extractErrorText(payload.error);
}
