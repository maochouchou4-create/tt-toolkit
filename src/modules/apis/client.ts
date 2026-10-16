/**
 * 统一请求客户端：choice 直连请求与 persona OpenAI 兼容请求
 * 合一。两个任务只差传参——出站身份与采样参数（url/key/model/
 * temperature/reasoningEffort）由任务路由单点解析（apis/task-profiles
 * 的 resolveTaskRoute），流式/输出契约按任务固化于 TASK_PARAMS。
 * 所有任务均不发 max_tokens：服务端用模型默认输出上限
 * （推理模型思维链与正文共享上限，显式小上限会把正文掐断——实测
 * deepseek-flash 2048 预算被思维链耗尽、正文截断在半条 JSON）。
 *
 * 单一传输通道＝宿主生成路由 `/api/backends/chat-completions/generate`
 * （type:'quiet' 旁路：不占宿主生成状态桥/通知；密钥经 reverse_proxy
 * 直达上游，不进宿主 secret store）。模型清单拉取与连通性测试无宿主
 * 路由可走（宿主不透传 /models），保持直连 Bearer 形态。
 *
 * 宿主核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - 生成端点 `/api/backends/chat-completions/generate`：
 *   tauri/main/routes/ai-routes.js:704 注册 POST；body 经
 *   invokeChatCompletionWithAbort（:356）整体转发 Rust 侧
 *   generate_chat_completion（dto 原样），翻译发生在
 *   tt-application chat_completion_service：
 *   - source=custom（custom_api_format 缺省＝openai_compat）：
 *     payload/custom.rs:16-26 → openai::build → 上游 endpoint
 *     `/chat/completions`（:103）；
 *   - 密钥路由：config.rs:221-229/343-344——custom 源 custom_url 为空
 *     且 reverse_proxy 非空 → base_url=reverse_proxy、
 *     api_key=proxy_password（直连密钥）；
 *   - response_format 通路：payload/openai.rs:222-224
 *     resolve_response_format——`response_format` 字段存在则原样透传
 *     （:288-293），否则 `json_schema:{name,strict,value}` 转换为
 *     OpenAI json_schema 形态（:296-325）；
 *   - temperature：build_chat_completion_payload
 *     insert_if_present（payload/openai.rs:149-184）——请求体不带的
 *     字段不会被宿主强加默认值（两任务不发 max_tokens 依赖此语义）；
 *   - `type:'quiet'`（ai-routes.js:179-181 isQuietRequest）：走
 *     lifecycle quiet 路径——失败时返回 502+错误体而非 200 错误
 *     completion（:745-747），程序化消费语义更干净。
 * - 流式响应形态：ai-routes.js:422 encodeSseDataFrame 逐帧
 *   `data: {chunk}\n\n` / `data: [DONE]\n\n`——上游 OpenAI SSE 帧
 *   原样重帧，delta 在 `choices[0].delta.content`。
 * - 非流式响应形态：choices[0].message.content；错误体 json.error。
 * - 请求头：script.js:1041 getRequestHeaders()（宿主适配层
 *   src/host/headers.ts 三级降级装配）。
 *
 * 文件分工：流式帧状态机在 client-sse.ts，流内与非流式共用的「上游 error
 * 键」判据出口在 client-error.ts（本文件只留请求发起与非流式响应解析）。
 */
import { getTavernRequestHeaders, HostApiError, isHostErrorEnvelopeId } from '@/host';
import { createTtlog } from '@/host/ttlog';
import { useRunlogStore } from '@/modules/runlog/store';
import type { RunTask } from '@/modules/runlog/types';
import { readUpstreamError } from './client-error';
import { readStream } from './client-sse';
import { composeOutbound } from './preset-inject';

const log = createTtlog('modules/apis/client');

/** 组装消息（role 三态分离，不拼单段塞单条——架构约束沿 fork 实证形态）。 */
export interface GenerateMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** 输出契约档位（choice json_object／persona prompt_only；json_schema 档随生成通道收敛退役——ds 官方 400 且永不被赋值）。 */
export type OutputContract = 'json_object' | 'prompt_only';

/**
 * 思考强度档位（G3）。'off'＝不发送该字段（默认——见 UI 端点配置的
 * 说明文案）；'low'|'medium'|'high' 映射为 OpenAI reasoning_effort 值。
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface GenerateRequestConfig {
    /** 任务归属（runlog 记录与摘要按任务区分；缺省会静默记错任务名，必填拒绝） */
    task: RunTask;
    /** API base（宿主会再拼 /chat/completions——normalizeApiUrl 已剥尾部路径） */
    baseUrl: string;
    /** 直连密钥（走 proxy_password 通道，不进宿主 secret store） */
    apiKey: string;
    model: string;
    /** 采样温度（undefined＝不发——任务域负责缺省值） */
    temperature?: number;
    stream: boolean;
    outputContract: OutputContract;
    /** 思考强度（off＝不发送，见 ReasoningEffort 注释） */
    reasoningEffort?: ReasoningEffort;
    /**
     * 请求级超时上限（秒，按任务固化于 TASK_PARAMS.timeoutSec）：到点自触发
     * 中止。必填不给默认——漏装就是一次可能永挂的请求，而死端点的表现是
     * 界面既不能停也不报错（原 client 注释自陈之痛）。
     */
    timeoutSec: number;
}

export interface GenerateResult {
    content: string;
    /** 请求走了流式还是非流式（GG 类假流式端点流式是硬需求） */
    streamed: boolean;
    /** 本次生成的 runlog 记录 id（任务层 enrich/markFailed 的目标句柄） */
    runId: number;
}

/** 生成端点（宿主前端路由，相对当前页面 origin）。 */
const GENERATE_URL = '/api/backends/chat-completions/generate';

/**
 * 规范化 API base 地址（宿主路由用：四步语义＝去尾斜杠→剥尾部
 * /chat/completions→再去剥完后残留的尾斜杠→仅裸域名补 /v1）。
 *
 * 表达距离声明：AFPL 合规——fork api-client 的同名函数按「链式
 * replace＋整行 hasPath 正则」实现，本实现自组顺序与写法（后缀剥离收
 * 成单一交替正则一次性消费；路径探测改 exec 显式分组），语义四步不变
 * （与宿主 openai.rs 拼 /chat/completions 到 base 末尾的装配语义对齐，
 * 用户填完整端点时防双拼）。
 */
const REDUNDANT_TAIL_RE = /(?:\/*\s*chat\/completions|\/*\s*)+$/i;
const PATH_LIKE_RE = /^([a-z][a-z0-9+.-]*:)(\/\/)([^/?#]+)([/?#].+)$/i;

export function normalizeApiUrl(url: string): string {
    const trimmed = url.trim();
    if (trimmed === '') return trimmed;
    // 「尾斜杠与 /chat/completions 结尾」按交替分支整体剥除（贪婪匹配
    // 会同时吃掉两种后缀的任意组合，含其后可能残留的尾斜杠）
    const base = trimmed.replace(REDUNDANT_TAIL_RE, '');
    // 有路径段（scheme://host/xxx，含 /v2、/v1beta/openai 等）则尊重所填；
    // 仅裸域名/裸 host 时补 OpenAI 默认 /v1（exec 分组把路径段显式隔离）
    return PATH_LIKE_RE.exec(base) !== null ? base : `${base}/v1`;
}

/**
 * base 归一（直连探测用：模型清单/测连走直连 Bearer，不经宿主路由）：
 * 剥尾斜杠与 /chat/completions，保留 /v1。
 */
export function normalizeApiBase(url: string): string {
    return String(url || '').replace(/\/$/, '').replace(/\/chat\/completions$/, '');
}

/** 响应体 → 模型名列表（OpenAI 信封 {data:[...]} 或裸数组双兼容）。 */
function extractModelList(data: unknown): string[] {
    const rawList = (data && typeof data === 'object' && 'data' in data ? (data as { data: unknown }).data : data) ?? [];
    return (Array.isArray(rawList) ? rawList : [])
        .map(m => (typeof m === 'string' ? m : (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id : '')))
        .filter(Boolean)
        .sort();
}

/** 轻量探测（测连/拉模型）的响应上界——无上界时死端点会挂到浏览器默认超时（分钟级），按钮即不能停也不报错。 */
const PROBE_TIMEOUT_SEC = 30;

/**
 * 请求级超时守卫（传输层唯一原语，探测与生成两路共用）。
 *
 * 自建 AbortController 供 fetch 使用，把「到点自触发中止」与「外部取消」
 * 汇进同一条中止通道——fetch 的失败面只有 aborted，两者在网络层不可分。
 * 但**上层必须能分开**：外部中止是用户按了取消（选项条「取消」／人设页
 * 「停止」），到点中止是死端点（要报失败、记 runlog、弹错误）。所以本原语
 * 另给一个 timedOut() 事实：它为真时，本次中止才是超时。只看
 * signal.aborted 的调用点会把超时误报成「已取消」——用户看到的是一句
 * 「已取消」，而他什么都没按，且这次失败连日志都不留痕。
 *
 * 收口走 dispose（清定时器＋解绑外部监听），调用点必须放在 finally——
 * 否则长请求在宿主里反复重试会攒下一次性的定时器与监听。
 */
export interface RequestTimeoutGuard {
    /** 传给 fetch 的中止信号（外部取消已汇入同一通道） */
    readonly signal: AbortSignal;
    /** 本次中止是否由到点触发（＝超时；外部取消时恒假） */
    timedOut(): boolean;
    dispose(): void;
}

export function startRequestTimeout(timeoutSec: number, external?: AbortSignal): RequestTimeoutGuard {
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => {
        try { controller.abort(); } catch { /* abort 对已结束的请求抛错无害 */ }
    };
    // 外部信号可能在装守卫前就已中止：addEventListener 不会为已中止的信号
    // 补发事件，漏这一手就是「带着一个已死的外部信号照发请求」。
    if (external?.aborted) abort();
    else external?.addEventListener('abort', abort);
    const timer = setTimeout(() => {
        timedOut = true;
        abort();
    }, timeoutSec * 1000);
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        dispose: () => {
            clearTimeout(timer);
            external?.removeEventListener('abort', abort);
        },
    };
}

/**
 * 超时的人话错误（传输层单点）：文案与判据同处一处，各调用点只按
 * instanceof 认它，不复写「到点 vs 取消」的判断。hint 由调用面给——
 * 探测与生成的补救动作不同（换端点 vs 稍后重试）。
 */
export class RequestTimeoutError extends Error {
    constructor(readonly timeoutSec: number, hint: string) {
        super(`请求超时（${timeoutSec} 秒）${hint}`);
        this.name = 'RequestTimeoutError';
    }
}

/** 生成请求超时的补救提示（各生成任务同一句——文案单点，见 RequestTimeoutError）。 */
const GENERATE_TIMEOUT_HINT = '——端点长时间无响应或中转站响应过慢，可稍后重试或更换端点';

/** 探测请求带超时上界：超时转译为人话错误（调用方 toast 即可读）。 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const guard = startRequestTimeout(PROBE_TIMEOUT_SEC, init.signal ?? undefined);
    try {
        return await fetch(url, { ...init, signal: guard.signal });
    } catch (err) {
        if (guard.timedOut()) throw new RequestTimeoutError(PROBE_TIMEOUT_SEC, '——端点无响应');
        throw err;
    } finally {
        guard.dispose();
    }
}

/**
 * 拉取模型名单（双候选端点探测：base 有 /vN → base/models，否则补
 * /v1/models；次选裸 base/models）。全部失败抛错（调用方 toast）。
 */
export async function fetchModels(url: string, key: string): Promise<string[]> {
    const cleanBase = normalizeApiBase(url);
    const endpoints = [
        /\/v\d+$/.test(cleanBase) ? `${cleanBase}/models` : `${cleanBase}/v1/models`,
        `${cleanBase}/models`,
    ];
    for (const ep of endpoints) {
        try {
            const res = await fetchWithTimeout(ep, { method: 'GET', headers: { 'Authorization': `Bearer ${key}` } });
            if (res.ok) return extractModelList(await res.json());
        } catch {
            // 换下一个候选端点
        }
    }
    throw new Error('连接失败或无法获取模型列表');
}

/**
 * 装配生成请求体（契约见文件头核实记录）。显式发送制：temperature/
 * max_tokens 未传（undefined）就不进请求体（宿主 insert_if_present
 * 同语义）——缺省值归任务域 normalize 保证，客户端不做任务侧默认。
 */
export function buildGenerateBody(messages: GenerateMessage[], config: GenerateRequestConfig): Record<string, unknown> {
    const body: Record<string, unknown> = {
        // quiet：不占宿主生成状态/通知（见文件头）；语义＝后台旁路生成
        type: 'quiet',
        // custom 源＝OpenAI 兼容直连（custom_api_format 缺省 openai_compat，
        // 经 openai::build 同一构建路径）：密钥路由与 openai 源相同
        // （reverse_proxy＋proxy_password），但 reasoning_effort 原样透传
        // ——openai 源按模型名白名单转发、白名单外静默丢弃（openai.rs:
        // 182-199），本扩展端点的模型名全在白名单外，走 openai 源等于
        // 思考强度永远发不出去。
        chat_completion_source: 'custom',
        // 密钥经 reverse_proxy 通道直达上游（config.rs:223-224），不落宿主 secret
        reverse_proxy: normalizeApiUrl(config.baseUrl),
        proxy_password: config.apiKey ?? '',
        model: config.model,
        messages,
        // 防 fetch 层改写：酒馆助手类预设脚本会 patch 主窗口 fetch 拦截
        // backends generate 请求并注入工具调用指令，tool_choice:"none" 是
        // 其 callerControlsTools 旁路信号（原样转发）。本请求无 tools、
        // 纯文本输出，语义自洽；对不 patch fetch 的环境该字段惰性。上游
        // 兼容性经验实证：同端点集（GG/ds/CC）携此字段日常运行长期无异常。
        // 宿主 agent 快照路径对 tool_choice 有显式拒绝（script.js:7092
        // assertAgentPromptSnapshotHasNoExternalTools）——本请求走 quiet
        // 旁路路由，不经过该断言。
        tool_choice: 'none',
    };
    if (config.temperature !== undefined) body.temperature = config.temperature;
    body.stream = config.stream;
    if (config.outputContract === 'json_object') {
        // json_object 形态宿主原样透传（openai.rs:288-293）
        body.response_format = { type: 'json_object' };
    }
    if (config.reasoningEffort && config.reasoningEffort !== 'off') {
        // 思考强度（G3）：值域对齐 OpenAI reasoning_effort（low/medium/high）。
        // 宿主侧语义（复核 D:\code\repos\TauriTavern\src-tauri 施工 HEAD）：
        // ①入站捕获：chat_completion_dto.rs ChatCompletionGenerateRequestDto
        //   payload 用 `#[serde(flatten)] Map<String,Value>`（:41-45），未知
        //   字段（含 reasoning_effort）整包进 Rust payload map；
        // ②出站：本客户端走 custom 源＝原样透传（openai.rs:182-186）；若换
        //   回 openai 源则仅模型名白名单（o1/o3/gpt-5.x 系，openai.rs:
        //   188-199 → openai_reasoning.rs:41-46）转发、其余静默丢弃——
        //   端点模型名不在白名单时字段等于没发，换源前必读；
        // ③ds 系模型名（deepseek-v4*/deepseek-flash）在 custom 源下命中
        //   宿主兼容网关分支：补 thinking:{type:"enabled"} 并透传
        //   reasoning_effort（deepseek.rs:58-81/184-189）——deepseek-flash
        //   不带 thinking 时本就默认思考，语义无翻转。
        // 上游接受度（带字段全 200 无错，四端点实测）：glm-5.3／
        // glm-5.3-flash／deepseek-flash／gemini 中转（中转是否消费字段
        // 由其自决，不报错即无害）。
        body.reasoning_effort = config.reasoningEffort;
    }
    // prompt_only：不发 response_format——纯提示词契约＋客户端解析兜底
    return body;
}

/** messages 序列化：每条「[role]\ncontent」，空行分段（人类可读排障形态）。 */
function serializeMessages(messages: GenerateMessage[]): string {
    return messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n');
}

/**
 * 前缀拼装唯一实现在 apis/preset-inject（composeOutbound）——出站拼装、
 * 运行日志 requestText 与组装 dump 都从同一函数派生。
 * 哨兵补记用：与实发同源的出站序列化（传输层外的任务层记录
 * requestText 时用它）。序列化原语 serializeMessages 模块私有——
 * 丢前缀的裸序列化在模块外结构上不可达。
 */
export function serializeOutbound(messages: GenerateMessage[]): string {
    return serializeMessages(composeOutbound(messages));
}

/**
 * 模型正文是否为空（空白正文也算空——上游静默拦截常回纯空白）。
 * 单一判据：choice 的零选项文案与 persona 的空响应报错同享，禁各自复写
 * （两处口径曾一处 trim 一处 falsy 而漂移——空白正文被 falsy 判空放行）。
 */
export function isBlankResponseContent(text: string): boolean {
    return text.trim() === '';
}

/**
 * 剥掉模型正文前导的 <think>…</think> 思维链包裹。
 * 为什么在传输层单点剥：破限前缀对所有散文任务（persona 等 prompt_only）
 * 下达 think 指令，模型依令先吐思维链再写正文——若各任务层自剥，口径
 * 会漂移（同一份 wire 正文在不同任务里时有时无）。仅剥前导完整块；
 * 前导 <think> 未闭合＝整段思维链被 token 上限掐断的形态，返回空串
 * 交 isBlankResponseContent 守门（下游零特判）。正文中段的 <think>
 * 不动（罕见，且可能是正文本身引用标签）。
 */
function stripReasoningWrapper(content: string): string {
    let rest = content;
    for (;;) {
        const lead = rest.trimStart();
        if (!lead.startsWith('<think>')) return rest;
        const end = lead.indexOf('</think>');
        if (end === -1) return '';
        rest = lead.slice(end + '</think>'.length);
    }
}

/**
 * 调用宿主生成端点。非流式：json.choices[0].message.content；
 * 流式：SSE delta 拼接。HTTP 非 2xx / json.error 均抛错（错误文本
 * 供上层提示与排障，Fail Fast 不吞）。
 *
 * 出站自动前置破限前缀（composeOutbound）：传入 messages ≠ 实发内容，
 * runlog 的 requestText 与 fetch body 序列化同一个 outbound 数组——
 * 日志看到的即模型收到的。
 *
 * 超时是传输层的职责：每次请求自带上限（config.timeoutSec），到点由守卫
 * 中止并转成 RequestTimeoutError（外部取消另走外部信号，途中到达也会中止
 * 同一条通道，但不算超时）。上层据此把「用户按了取消」与「端点没响应」
 * 分成两种可见结果——两者在 fetch 的失败面上同形，只有本层分得开。
 *
 * 运行日志观测点（choice/persona 通吃的单一传输层）：成功失败（含
 * abort/流读失败/超时）全量 commit 一条记录后原样抛/返——任务层只凭返回的
 * runId enrich，传输失败无 runId 也「失败有痕」。apiKey 不进记录。
 */
export async function callGenerateEndpoint(
    messages: GenerateMessage[],
    config: GenerateRequestConfig,
    signal?: AbortSignal,
): Promise<GenerateResult> {
    const startedAt = performance.now();
    const runlogStore = useRunlogStore();
    const outbound = composeOutbound(messages);
    if (outbound.length > messages.length) {
        log.info(`破限注入 (${config.task}): ${outbound.length - messages.length} 条前缀`);
    }
    const requestText = serializeMessages(outbound);
    const commitRun = (ok: boolean, responseText: string, error?: string): number =>
        runlogStore.commit({
            at: new Date().toISOString(),
            task: config.task,
            endpointUrl: normalizeApiBase(config.baseUrl),
            model: config.model,
            contract: config.outputContract,
            stream: config.stream,
            durationMs: Math.round(performance.now() - startedAt),
            ok,
            requestText,
            responseText,
            error,
        });
    const guard = startRequestTimeout(config.timeoutSec, signal);
    // 截断判定结果（try 外抛出防 catch 双记：截断记录须带半截正文供诊断）
    let truncated: { content: string } | null = null;
    try {
        const response = await fetch(GENERATE_URL, {
            method: 'POST',
            headers: getTavernRequestHeaders(),
            body: JSON.stringify(buildGenerateBody(outbound, config)),
            cache: 'no-cache',
            signal: guard.signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            // 表达距离声明：AFPL 合规——错误文案自写措辞（fork 为「API 请求失败
            // (status): 截断文本」模板）；保留的语义＝状态码＋响应体截断预览，
            // 供上层提示与排障定位，Fail Fast 不吞。
            throw new Error(`生成端点拒绝请求，HTTP ${response.status}。响应体开头：${text.slice(0, 300)}`);
        }
        if (config.stream) {
            const { content, finishReason } = await readStream(response);
            if (finishReason === 'length') {
                truncated = { content };
            } else {
                // commitRun 记原始 wire 正文（runlog 是排障设施，如实记端点
                // 返回）；返回给任务层的是剥净思维链后的正文
                return { content: stripReasoningWrapper(content), streamed: true, runId: commitRun(true, content) };
            }
        } else {
            const data = (await response.json()) as {
                id?: unknown;
                choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
                error?: unknown;
            };
            // 错误信封先判（宿主把失败包装成 200 + 正常 chat.completion 壳，
            // 与非流式成功响应同形——id 前缀是唯一结构化标志）
            if (isHostErrorEnvelopeId(data?.id)) {
                throw new HostApiError(data?.choices?.[0]?.message?.content || '生成端点返回宿主错误信封');
            }
            // 上游 error 键与流式帧共用同一出口（判据与文案都在 readUpstreamError：
            // 两出口各写一份判断时 `{"error":""}` 会一边抛错一边放行）
            const upstreamError = readUpstreamError(data);
            if (upstreamError !== null) throw new HostApiError(upstreamError || '生成端点返回上游错误响应（error 键无文案）');
            const content = data?.choices?.[0]?.message?.content ?? '';
            if (data?.choices?.[0]?.finish_reason === 'length') {
                truncated = { content };
            } else {
                return { content: stripReasoningWrapper(content), streamed: false, runId: commitRun(true, content) };
            }
        }
    } catch (e) {
        // 到点中止在此转成超时错误再落记录：失败面必须带「超时」两个字，
        // 直接把 fetch 的 AbortError 记进去等于这次失败在日志里查无实据。
        const failure = guard.timedOut() ? new RequestTimeoutError(config.timeoutSec, GENERATE_TIMEOUT_HINT) : e;
        commitRun(false, '', failure instanceof Error ? failure.message : String(failure));
        throw failure;
    } finally {
        guard.dispose();
    }
    // 截断：内容收到但被服务端 token 上限掐断——不捕它会伪装成下游解析失败。
    // 记录保留半截正文（排障可见掐在哪里），报错指名真因
    const message = '输出被截断（finish_reason=length，达到服务端 token 上限）——推理模型的思维链与正文共享上限；请更换输出上限更高的端点，或先用记忆插件折叠更早楼层压缩输入';
    commitRun(false, truncated.content, message);
    throw new Error(message);
}
