/**
 * PersonaWeaver fork 独立 API 传输层（批D 平移，砍 Anthropic 原生协议）。
 *
 * MODIFICATIONS（相对上游 fork）：
 * - 只保留 OpenAI 兼容形态（OpenRouter/DeepSeek/中转站/本地 llama.cpp 一律
 *   按兼容组装）；Anthropic 原生协议（x-api-key 头 / v1/messages /
 *   content_block_delta 帧 / max_tokens 按模型推断）整体退役。
 * - resolveMaxTokens 恒 0（不发送 max_tokens，服务端用模型默认上限——
 *   对长 YAML 最友好），保留函数以维持「max_tokens 不进设置」的契约注释。
 * - defaultSettings/getIndepTimeoutSec/getIndepStreamEnabled 的 DOM 读取链
 *   退役：调用方（store）直接传存储域值。
 * - 密钥只在内存/存储域（extension_settings.ttToolkit.persona），不进
 *   宿主 secret store；请求为纯 fetch，不走宿主路由。
 */

import type { ThinkingEffort } from './storage';

/** 独立 API 请求面（配置值由 store 从域透传）。 */
export interface IndepApiRequestConfig {
    url: string;
    apiKey: string;
    model: string;
    /** 流式输出（默认开启——避免 Cloudflare/中转站 504）。 */
    stream: boolean;
    /** 思考强度（'off'＝不注入 reasoning_effort）。 */
    thinkingEffort: ThinkingEffort;
}

/** base 归一（OpenAI 兼容单形态）：剥尾斜杠与 /chat/completions，保留 /v1。 */
export function normalizeApiBase(url: string): string {
    return String(url || '').replace(/\/$/, '').replace(/\/chat\/completions$/, '');
}

/**
 * max_tokens 决策：恒 0＝不发送该字段，服务端使用模型默认最大值。
 * （旧 Anthropic 分支按 Claude 型号推断 4K~32K 的逻辑已随协议砍除。）
 */
export function resolveMaxTokens(): number {
    return 0;
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
 * 调用方）。无超时控制——浏览器默认超时兜底（与旧实现一致）。
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

/** 组装 OpenAI 兼容请求（headers+body；温度固定 1.00，max_tokens 恒不注入）。 */
export function buildOpenAIRequest(
    messages: Array<{ role: string; content: string }>,
    apiConfig: IndepApiRequestConfig,
    useStream: boolean,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const cleanBase = normalizeApiBase(apiConfig.url);
    const payload: Record<string, unknown> = {
        model: apiConfig.model,
        messages,
        temperature: 1.00,
    };
    // max_tokens：resolveMaxTokens()=0 → 不发送（服务端默认上限，长 YAML 友好）
    if (resolveMaxTokens() > 0) {
        payload.max_tokens = resolveMaxTokens();
    }
    if (apiConfig.thinkingEffort !== 'off') {
        payload.reasoning_effort = apiConfig.thinkingEffort;
    }
    if (useStream) {
        payload.stream = true;
    }
    return {
        url: `${cleanBase}/chat/completions`,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiConfig.apiKey}`,
        },
        body: payload,
    };
}

/**
 * SSE 流式响应解析（OpenAI 兼容）：
 * - `data: {"choices":[{"delta":{"content":"..."}}]}` / `data: [DONE]`
 * - delta.content 数组形态（部分兼容实现 [{type:'text',text:'...'}]）
 * - 流内 error 帧抛错；畸形 JSON 帧静默跳过（心跳/重帧不推翻整次读取）
 * - 帧分隔 \n\n 与 \r\n\r\n 双兼容；流尾无空行也补处理
 */
export async function readSSEResponse(res: Response): Promise<string> {
    if (!res.body || !res.body.getReader) {
        const text = await res.text();
        throw new Error(`当前浏览器不支持 Fetch 流式读取，无法解析流式响应。请关闭『流式输出』再试。原始返回前 200 字: ${text.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';
    let sawAnyDelta = false;

    const processEvent = (event: string): void => {
        const lines = event.split('\n');
        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            if (!line.startsWith('data:')) continue;
            const dataStr = line.substring(5).trim();
            if (!dataStr || dataStr === '[DONE]') continue;
            let json: unknown;
            try {
                json = JSON.parse(dataStr) as unknown;
            } catch {
                continue;
            }
            const record = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};

            let piece = '';
            const choices = record.choices;
            if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
                const delta = (choices[0] as Record<string, unknown>).delta ?? (choices[0] as Record<string, unknown>).message ?? {};
                const deltaRecord = delta && typeof delta === 'object' ? (delta as Record<string, unknown>) : {};
                if (typeof deltaRecord.content === 'string') {
                    piece = deltaRecord.content;
                } else if (Array.isArray(deltaRecord.content)) {
                    piece = (deltaRecord.content as Array<Record<string, unknown>>)
                        .map(b => (b && typeof b.text === 'string' ? b.text : ''))
                        .join('');
                }
            }
            // 错误帧（部分中转站在 stream 里塞 error 对象）
            const err = record.error;
            if (err && (typeof err === 'object' || typeof err === 'string')) {
                const message = err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string'
                    ? (err as { message: string }).message
                    : String(err);
                throw new Error(`API 流式错误: ${message}`);
            }
            if (piece) {
                fullText += piece;
                sawAnyDelta = true;
            }
        }
    };

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 事件以空行分隔，\n\n 与 \r\n\r\n 双兼容
        for (;;) {
            const a = buffer.indexOf('\n\n');
            const b = buffer.indexOf('\r\n\r\n');
            if (a === -1 && b === -1) break;
            const idx = a === -1 ? b : (b === -1 ? a : Math.min(a, b));
            const sep = idx === b ? 4 : 2;
            const event = buffer.substring(0, idx);
            buffer = buffer.substring(idx + sep);
            if (event.trim().length > 0) processEvent(event);
        }
    }
    // 尾巴可能没有空行结束，补处理一次
    buffer += decoder.decode();
    if (buffer.trim().length > 0) processEvent(buffer);

    if (!fullText && !sawAnyDelta) {
        throw new Error('流式响应为空（可能被反代吞掉或模型未返回文本）。可尝试关闭『流式输出』切回非流式模式。');
    }
    return fullText;
}
