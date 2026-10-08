/**
 * 宿主 API 错误面（host 适配层）：TauriTavern 生成失败时不抛错给调用方，
 * 而是把错误**伪装成正常回复**。伪装有两处出口、各自带不同的可用标志，
 * 本文件是「这段文本/这个信封是不是宿主错误」的唯一判据所在——消费方禁
 * 各自复写（落盘楼层与当次响应两条路都从这里取）。
 *
 * 形态 A（当次 HTTP 响应）：流已经开始之后才失败时，宿主往这条 HTTP 200
 * 的 SSE 里补一帧「正常 chunk 壳」装错误正文（ai-routes.js:269-286）；
 * 未开流就失败则走 502 + {error}（:745-747），由 response.ok 兜住。信封
 * id 前缀是结构化标志（buildOpenAiStyleErrorChunk 与
 * buildErrorCompletionPayload 各自带 `tauritavern-error` 前缀）。
 *
 * 形态 B（聊天落盘＝历史楼层）：错误被写成一条正常 assistant 消息
 * （正文以 [API 错误] 标签开头、finish_reason='stop'，消息对象上没有任何
 * 结构化错误字段）——落盘后无标志可用，只能靠文本前缀判别。
 *
 * 因此 isHostErrorEnvelopeId 覆盖形态 A（当次响应，判据不看正文，故正常
 * 产出即使正文以该标签开头也不会被误杀）；isHostErrorText 覆盖形态 B
 * （落盘楼层——信封已不存在，文本前缀是唯一可用判据）。
 *
 * 形态 A 的帧形状分派值得记一笔：宿主按 chat_completion_source 分派错误
 * 帧（ai-routes.js:288-327），claude/vertexai-claude/makersuite 三支**不带
 * id**；本扩展的请求恒为 source=openai（apis/client 的 buildGenerateBody
 * 硬编码 chat_completion_source='openai'），故恒走带 id 的 OpenAI 形态。
 * 若将来扩展改成多源出站，这里的信封判据必须连同出站源一起复核。
 *
 * 核实记录（D:\code\repos\TauriTavern\src）：
 *   - tauri/main/routes/ai-routes.js:232-240 buildErrorAssistantText——
 *     错误正文一定以 translateApiErrorLabel() 开头；:235 宿主自己的判别式
 *     也是 startsWith(errorLabel) || startsWith('[API Error]')，本文件的
 *     文本判据与宿主同源（含英文硬编码兜底）。
 *   - tauri/main/routes/ai-error-presenter.js:27-29
 *     translateApiErrorLabel = `[${translateSillyTavern('API Error','API Error')}]`。
 *   - tauri/main/routes/ai-routes.js:247 非流式错误信封 id
 *     `tauritavern-error-<ts>`；:272 流式错误帧 id
 *     `tauritavern-error-chunk-<ts>`——同一前缀，故判据只认前缀。
 *   - scripts/i18n.js:122 export function translate(text, key = null) {
 */

import { translate as stTranslate } from '@sillytavern/scripts/i18n';

/** 宿主落地错误正文的前缀标签（同源计算，zh-cn 下为 '[API 错误]'）。 */
function getHostApiErrorLabel(): string {
    return `[${stTranslate('API Error')}]`;
}

/** 宿主错误信封 id 前缀（流式错误帧多一个 chunk 中缀，前缀匹配覆盖两形态）。 */
const HOST_ERROR_ENVELOPE_PREFIX = 'tauritavern-error';

/**
 * 当次响应的信封是否为宿主错误（形态 A）：解析原始 JSON 的一方用这个。
 */
export function isHostErrorEnvelopeId(id: unknown): boolean {
    return typeof id === 'string' && id.startsWith(HOST_ERROR_ENVELOPE_PREFIX);
}

/**
 * 文本是否为宿主错误正文（形态 A 的帧正文 / 形态 B 的落盘正文）：
 * 拿到的是文本而非原始信封时用这个。
 */
export function isHostErrorText(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    const trimmed = text.trimStart();
    return trimmed.startsWith(getHostApiErrorLabel()) || trimmed.startsWith('[API Error]');
}

/**
 * 宿主错误信封在调用链里的呈现（形态 A 的传输层出口）。
 *
 * 为什么要有独立类型：调用方需要把「上游真的失败了」与「网络不通/超时」
 * 分开——前者带着上游原文（含 statusCode 一类字段），后者要换成可操作
 * 的人话提示。独立类型让这条分界在类型层可见，而不是靠 message 文本猜。
 *
 * 不继承任何宿主类型（纯 Error 子类）：本文件不带 @sillytavern 依赖之外的
 * 外部面，放这里与两个判据同处一文件，使「宿主错误面」这个概念完整归位
 * ——定义与识别不再分居两层。
 */
export class HostApiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HostApiError';
    }
}
