/**
 * 统一请求客户端（整合轮II）：choice 直连请求与 persona OpenAI 兼容请求
 * 合一。两个任务只差传参——任务参数（输出契约/思考强度/流式/超时/
 * max_tokens/信号）留在各自任务域，端点身份（url/key/model）从统一
 * 端点表取。
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
 *   - source=openai：payload/openai.rs:63-67 → openai::build → 上游
 *     endpoint `/chat/completions`（:103）；
 *   - 密钥路由：config.rs:244-252——source 非 custom 且 reverse_proxy
 *     非空 → base_url=reverse_proxy、api_key=proxy_password（直连密钥）；
 *   - response_format 通路：payload/openai.rs:222-224
 *     resolve_response_format——`response_format` 字段存在则原样透传
 *     （:288-293），否则 `json_schema:{name,strict,value}` 转换为
 *     OpenAI json_schema 形态（:296-325）；
 *   - temperature/max_tokens：build_chat_completion_payload
 *     insert_if_present（payload/openai.rs:149-184）——请求体不带的
 *     字段不会被宿主强加默认值（persona 不发 max_tokens 依赖此语义）；
 *   - `type:'quiet'`（ai-routes.js:179-181 isQuietRequest）：走
 *     lifecycle quiet 路径——失败时返回 502+错误体而非 200 错误
 *     completion（:745-747），程序化消费语义更干净。
 * - 流式响应形态：ai-routes.js:422 encodeSseDataFrame 逐帧
 *   `data: {chunk}\n\n` / `data: [DONE]\n\n`——上游 OpenAI SSE 帧
 *   原样重帧，delta 在 `choices[0].delta.content`。
 * - 非流式响应形态：choices[0].message.content；错误体 json.error。
 * - 请求头：script.js:1041 getRequestHeaders()（宿主适配层
 *   src/host/headers.ts 三级降级装配）。
 */
import { getTavernRequestHeaders } from '@/host';

/** 组装消息（role 三态分离，不拼单段塞单条——架构约束沿 fork 实证形态）。 */
export interface GenerateMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** 输出契约档位（方案 §1 P-JSON：服务商结构化输出优先＋客户端解析兜底）。 */
export type OutputContract = 'json_schema' | 'json_object' | 'prompt_only';

/**
 * 思考强度档位（G3）。'off'＝不发送该字段（默认——见 UI 端点配置的
 * 说明文案）；'low'|'medium'|'high' 映射为 OpenAI reasoning_effort 值。
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

const REASONING_EFFORTS: readonly string[] = ['off', 'low', 'medium', 'high'];

/**
 * 思考强度档位守门（choice/persona 两活域共用单点）：存档里的历史值
 * 不可信，枚举外回退 fallback（活域语义＝'off' 不发送字段）。
 * legacy 迁移侧的流式缺省特例见 apis/migration.ts（与本函数无关——
 * 那是 stream 字段的旧用户行为保真，不是思考强度档位问题）。
 */
export function normalizeReasoningEffort(raw: unknown, fallback: ReasoningEffort = 'off'): ReasoningEffort {
    return (typeof raw === 'string' && REASONING_EFFORTS.includes(raw) ? raw : fallback) as ReasoningEffort;
}

export interface GenerateRequestConfig {
    /** API base（宿主会再拼 /chat/completions——normalizeApiUrl 已剥尾部路径） */
    baseUrl: string;
    /** 直连密钥（走 proxy_password 通道，不进宿主 secret store） */
    apiKey: string;
    model: string;
    /** 采样温度（undefined＝不发——任务域负责缺省值） */
    temperature?: number;
    /** max_tokens 上限（undefined＝不发，服务端用模型默认——persona 长文本依赖） */
    maxTokens?: number;
    stream: boolean;
    outputContract: OutputContract;
    /** 思考强度（off＝不发送，见 ReasoningEffort 注释） */
    reasoningEffort?: ReasoningEffort;
    /** json_schema 模式的 schema 本体（name/strict 由调用方语义固定） */
    jsonSchema?: unknown;
}

export interface GenerateResult {
    content: string;
    /** 请求走了流式还是非流式（GG 类假流式端点流式是硬需求） */
    streamed: boolean;
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
            const res = await fetch(ep, { method: 'GET', headers: { 'Authorization': `Bearer ${key}` } });
            if (res.ok) return extractModelList(await res.json());
        } catch {
            // 换下一个候选端点
        }
    }
    throw new Error('连接失败或无法获取模型列表');
}

/**
 * 连通性测试：发一次最小请求，原样返回 fetch 响应（ok 判定与 toast 归
 * 调用方）。无超时控制——浏览器默认超时兜底。
 */
export async function testConnection(url: string, key: string, model: string): Promise<Response> {
    const cleanBase = normalizeApiBase(url);
    const ep = /\/v\d+$/.test(cleanBase) ? `${cleanBase}/chat/completions` : `${cleanBase}/v1/chat/completions`;
    return await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 }),
    });
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
        chat_completion_source: 'openai',
        // 密钥经 reverse_proxy 通道直达上游（config.rs:251-252），不落宿主 secret
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
    if (config.maxTokens !== undefined) body.max_tokens = config.maxTokens;
    body.stream = config.stream;
    if (config.outputContract === 'json_schema' && config.jsonSchema) {
        // 走宿主原生 json_schema 字段：服务端补 name/strict 默认并转
        // response_format（openai.rs:296-325），与宿主 quiet prompt 的
        // 结构化输出同一条通路
        body.json_schema = { name: 'options', strict: true, value: config.jsonSchema };
    } else if (config.outputContract === 'json_object') {
        // json_object 形态宿主原样透传（openai.rs:288-293）
        body.response_format = { type: 'json_object' };
    }
    if (config.reasoningEffort && config.reasoningEffort !== 'off') {
        // 思考强度（G3）：值域对齐 OpenAI reasoning_effort（low/medium/high）。
        // 宿主侧两级语义（复核 D:\code\repos\TauriTavern\src-tauri 施工 HEAD）：
        // ①入站捕获：chat_completion_dto.rs ChatCompletionGenerateRequestDto
        //   payload 用 `#[serde(flatten)] Map<String,Value>`（:41-45），未知
        //   字段（含 reasoning_effort）整包进 Rust payload map；
        // ②出站双通路（openai.rs build_chat_completion_payload）：
        //   - source=="custom" 时 reasoning_effort 原样透传（openai.rs:
        //     182-186）；
        //   - source=="openai" 且模型名命中推理系白名单（o1/o3/gpt-5.x，
        //     openai.rs:188-199 → openai_reasoning.rs:41-46）时经
        //     normalize 后转发，其余 openai 原生源静默丢弃（本客户端走
        //     openai 源——与 UI「仅部分端点支持，发错档会被端点忽略或
        //     报错，默认不发」说明口径一致）。
        body.reasoning_effort = config.reasoningEffort;
    }
    // prompt_only：不发 response_format——纯提示词契约＋客户端解析兜底
    return body;
}

/**
 * 流式读取：完整 SSE 帧状态机拼接 delta（帧形态见文件头核实记录）。
 *
 * 表达距离声明：AFPL 合规——fork 按「逐行 split＋pop 保留半行」的
 * 行缓冲骨架实现，本实现改为按事件边界（\n\n）切帧的状态机：缓冲区
 * 只在完整帧落地时消费，帧内 data 字段逐条解析；流收尾时把无终止符
 * 的尾帧也消费掉（fork 骨架会静默丢弃残留在缓冲里的尾行）。
 * 宿主契约语义不变：`data: {json}\n\n` / `data: [DONE]\n\n`，delta 在
 * choices[0].delta.content。
 */
const SSE_FRAME_TERMINATOR = '\n\n';

async function readStream(response: Response): Promise<string> {
    if (!response.body) throw new Error('流式响应无 body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let pending = '';

    const consumeFrame = (frame: string): void => {
        for (const field of frame.split('\n')) {
            if (!field.startsWith('data:')) continue;
            const data = field.slice('data:'.length).trim();
            if (data === '[DONE]') continue;
            try {
                const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
                full += json?.choices?.[0]?.delta?.content ?? '';
            } catch {
                // 单帧畸形不推翻整次读取（重帧/心跳帧等）
            }
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // \r\n 归一成 \n：上游个别代理会改写换行风格，帧边界探测只认 \n\n
        pending += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
        let cut = pending.indexOf(SSE_FRAME_TERMINATOR);
        while (cut !== -1) {
            consumeFrame(pending.slice(0, cut));
            pending = pending.slice(cut + SSE_FRAME_TERMINATOR.length);
            cut = pending.indexOf(SSE_FRAME_TERMINATOR);
        }
    }
    // 尾帧可能没有终止符就断流：一并消费（丢它会少最后一段 delta）
    consumeFrame(pending);
    return full;
}

/**
 * 调用宿主生成端点。非流式：json.choices[0].message.content；
 * 流式：SSE delta 拼接。HTTP 非 2xx / json.error 均抛错（错误文本
 * 供上层提示与排障，Fail Fast 不吞）。
 */
export async function callGenerateEndpoint(
    messages: GenerateMessage[],
    config: GenerateRequestConfig,
    signal?: AbortSignal,
): Promise<GenerateResult> {
    const response = await fetch(GENERATE_URL, {
        method: 'POST',
        headers: getTavernRequestHeaders(),
        body: JSON.stringify(buildGenerateBody(messages, config)),
        cache: 'no-cache',
        signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        // 表达距离声明：AFPL 合规——错误文案自写措辞（fork 为「API 请求失败
        // (status): 截断文本」模板）；保留的语义＝状态码＋响应体截断预览，
        // 供上层提示与排障定位，Fail Fast 不吞。
        throw new Error(`生成端点拒绝请求，HTTP ${response.status}。响应体开头：${text.slice(0, 300)}`);
    }
    if (config.stream) {
        return { content: await readStream(response), streamed: true };
    }
    const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
    };
    if (data?.error) throw new Error(data.error.message || '生成端点返回错误');
    return { content: data?.choices?.[0]?.message?.content ?? '', streamed: false };
}
