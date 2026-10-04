/**
 * TT 宿主生成端点适配：独立 API 自拼请求（方案 §1 P-API 已拍板）。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - 生成端点 `/api/backends/chat-completions/generate`：
 *   tauri/main/routes/ai-routes.js:704 注册 POST；body 经
 *   invokeChatCompletionWithAbort（:356）整体转发 Rust 侧
 *   generate_chat_completion（dto 原样），翻译发生在
 *   tt-application chat_completion_service：
 *   - source=openai：payload/openai.rs:63-67 → openai::build → 上游
 *     endpoint `/chat/completions`（:103）；
 *   - 密钥路由：config.rs:244-252——source 非 custom 且 reverse_proxy
 *     非空 → base_url=reverse_proxy、api_key=proxy_password（直连密钥，
 *     不进宿主 secret store）；
 *   - response_format 通路：payload/openai.rs:222-224
 *     resolve_response_format——`response_format` 字段存在则原样透传
 *     （:288-293），否则 `json_schema:{name,strict,value}` 转换为
 *     OpenAI json_schema 形态（:296-325）；
 *   - `type:'quiet'`（ai-routes.js:179-181 isQuietRequest）：走
 *     lifecycle quiet 路径——不占用宿主生成状态桥/完成通知
 *     （generation-lifecycle-service.js:172-183），失败时返回
 *     502+错误体而非 200 错误 completion（:745-747），程序化消费语义
 *     更干净。选项生成本就是后台旁路请求，quiet 语义正确。
 * - 流式响应形态：ai-routes.js:422 encodeSseDataFrame 逐帧
 *     `data: {chunk}\n\n` / `data: [DONE]\n\n`——上游 OpenAI SSE 帧
 *     原样重帧，delta 在 `choices[0].delta.content`。
 * - 非流式响应形态：choices[0].message.content；错误体 json.error
 *     （custom-request.js:472-476 宿主自家旁路请求同款消费方式）。
 * - 请求头：script.js:1041 getRequestHeaders()（CSRF token 等），
 *   st-context.js:135 经 getContext() 暴露——本层走 ESM 直接导入。
 */

import { getRequestHeaders as stGetRequestHeaders } from '@sillytavern/script';
import { getTavernContext } from './context';

/** 组装消息（role 三态分离，不拼单段塞单条——架构约束沿 fork 实证形态）。 */
export interface GenerateMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** 输出契约档位（方案 §1 P-JSON：服务商结构化输出优先＋客户端解析兜底）。 */
export type OutputContract = 'json_schema' | 'json_object' | 'prompt_only';

export interface GenerateRequestConfig {
    /** API base（宿主会再拼 /chat/completions——normalizeApiUrl 已剥尾部路径） */
    baseUrl: string;
    /** 直连密钥（走 proxy_password 通道，不进宿主 secret store） */
    apiKey: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    stream: boolean;
    outputContract: OutputContract;
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
 * 规范化 API base 地址：去尾斜杠→剥尾部 /chat/completions（宿主总是
 * 再拼一次，用户填完整端点时防双拼）→仅裸域名补 /v1。
 * 与宿主拼装语义对齐（openai.rs 拼 /chat/completions 到 base 末尾）。
 */
export function normalizeApiUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) return trimmed;
    let clean = trimmed.replace(/\/+$/, '');
    clean = clean.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
    const hasPath = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/.+$/i.test(clean);
    return hasPath ? clean : `${clean}/v1`;
}

/** 请求头：优先 ESM 导入，宿主版本漂移时降级 context 转发，再缺则裸头。 */
function requestHeaders(): Record<string, string> {
    try {
        const h = stGetRequestHeaders();
        if (h && typeof h === 'object') return h as Record<string, string>;
    } catch {
        // ESM 导入抛错＝宿主版本漂移，走 context 通道
    }
    const fromContext = getTavernContext()?.getRequestHeaders as (() => Record<string, string>) | undefined;
    if (typeof fromContext === 'function') {
        try {
            return fromContext();
        } catch {
            // 双通道都坏：发裸头（无 CSRF 大概率 403，错误信息仍可判读）
        }
    }
    return { 'Content-Type': 'application/json' };
}

/** 装配生成请求体（契约见文件头核实记录）。 */
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
        temperature: config.temperature ?? 0.7,
        max_tokens: config.maxTokens ?? 2048,
        stream: config.stream,
    };
    if (config.outputContract === 'json_schema' && config.jsonSchema) {
        // 走宿主原生 json_schema 字段：服务端补 name/strict 默认并转
        // response_format（openai.rs:296-325），与宿主 quiet prompt 的
        // 结构化输出同一条通路
        body.json_schema = { name: 'options', strict: true, value: config.jsonSchema };
    } else if (config.outputContract === 'json_object') {
        // json_object 形态宿主原样透传（openai.rs:288-293）
        body.response_format = { type: 'json_object' };
    }
    // prompt_only：不发 response_format——纯提示词契约＋客户端解析兜底
    return body;
}

/** 流式读取：SSE 帧拼接 delta（帧形态见文件头核实记录）。 */
async function readStream(response: Response): Promise<string> {
    if (!response.body) throw new Error('流式响应无 body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // 最后一行可能跨 chunk 边界不完整，留到下一轮拼接
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice('data: '.length).trim();
            if (data === '[DONE]') continue;
            try {
                const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
                full += json?.choices?.[0]?.delta?.content ?? '';
            } catch {
                // 单帧畸形不推翻整次读取（重帧/心跳帧等）
            }
        }
    }
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
        headers: requestHeaders(),
        body: JSON.stringify(buildGenerateBody(messages, config)),
        cache: 'no-cache',
        signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`生成请求失败 (${response.status}): ${text.slice(0, 300)}`);
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
