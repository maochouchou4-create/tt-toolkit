/**
 * 选项生成管线（方案 §2.4）：组装（引擎）→ 请求（统一端点表＋共享客户端）
 * → 解析（response_format 主路径＋客户端兜底）→ 渲染（store 会话态）。
 *
 * 组装结果（消息数组＋trace）每次生成后进 dump 设施（批B 验收断言的
 * 依赖设施——用户靠它核对各注入模块逐项可见）。
 */
import { getSendTextareaValue, sendInputMessage, setSendTextareaValue, showToast } from '@/host';
import { callGenerateEndpoint, type GenerateRequestConfig } from '@/modules/apis/client';
import {
    assembleMessages,
    collectAssemblySources,
    renderDump,
    usePromptsStore,
    type PoolInjectionSupply,
} from '@/prompts';
import type { ModuleTrace } from '@/prompts';
import { choiceStorage, resolveChoiceEndpoint } from './api';
import { useStoryDirectionStore } from './direction';
import { DEBUG_MALFORMED_RAW, parseOptions } from './parse';
import { drawPoolInjection } from './pool/storage';
import { useChoiceStore } from './store';

/**
 * 选项 JSON 契约 schema（json_schema 档位的结构化输出定义；与 output_format
 * 模块文本同一契约：顶层 {"options":[...]} 对象、元素 {title,content}——
 * schema 与提示词说的是同一件事，不各说各话）。
 * 顶层用对象而非裸数组：json_object 档的规范只保证「输出是 JSON 对象」，
 * 顶层数组契约与之矛盾；统一对象形态让两档语义一致。数量不在 schema
 * 硬编码（{{count}} 运行时变化），由提示词约束。客户端解析对裸数组
 * 仍容错（parse 回退吸收，兼容旧输出与不守契约的模型）。
 */
const OPTIONS_JSON_SCHEMA = {
    type: 'object',
    properties: {
        options: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: '简短标题（10字内）' },
                    content: { type: 'string', description: '选项正文（具体的行动描述）' },
                },
                required: ['title', 'content'],
                additionalProperties: false,
            },
            minItems: 1,
        },
    },
    required: ['options'],
    additionalProperties: false,
} as const;

/** 外部取消信号（选项条「取消」按钮）。 */
let activeAbort: AbortController | null = null;

export function cancelGeneration(): void {
    activeAbort?.abort();
    activeAbort = null;
}

export function isGenerating(): boolean {
    return activeAbort !== null;
}

/**
 * 组装当前上下文的消息数组（dump 口与生成管线共用一条路径——dump 显示
 * 的就是实际发送的内容，不存在「展示与发送两套组装」）。
 *
 * 批C：池供给在这里现场抽取（每次组装重抽、pinned 恒在）——抽一次快照
 * 传给 sources/engine，prompts 层不回读 choice 域（单向供给）。
 */
export async function assembleCurrent(): Promise<{ dumpText: string; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; trace: ModuleTrace[] }> {
    const promptsStore = usePromptsStore();
    const config = promptsStore.effectiveConfig;
    if (!config) throw new Error('提示词配置缺席（storage 未初始化？）');
    const gen = choiceStorage.readDomain().gen;
    const poolInjection: PoolInjectionSupply = drawPoolInjection();
    const sources = await collectAssemblySources({
        storyDirection: useStoryDirectionStore().storyDirection,
        contextRounds: gen.contextRounds,
        count: gen.count,
        minChars: gen.minChars,
        maxChars: gen.maxChars,
        poolInjection,
    });
    const result = assembleMessages(config.modules, sources);
    return { dumpText: renderDump(result), messages: result.messages, trace: result.trace };
}

/**
 * 生成一次行动选项（全流程）。生成中重复调用拒绝（防并发重入）。
 * 调试开关 debugForceRaw 开启时跳过 API，用固定畸形样本走解析路径
 * （回退路径可确定性触发——批B 判据载体）。
 */
export async function generateOptions(): Promise<void> {
    const store = useChoiceStore();
    if (activeAbort) return;
    const controller = new AbortController();
    activeAbort = controller;

    store.beginGenerate();
    try {
        const gen = choiceStorage.readDomain().gen;
        let rawText: string;
        let outputContract: GenerateRequestConfig['outputContract'] = 'prompt_only';
        const assembly = await assembleCurrent();
        store.lastDump = assembly.dumpText;

        if (gen.debugForceRaw) {
            rawText = DEBUG_MALFORMED_RAW;
        } else {
            const endpoint = resolveChoiceEndpoint();
            const task = choiceStorage.readDomain().task;
            if (!endpoint) {
                throw new Error('未选择生成端点——在「API」页添加端点后，到「选项生成」设置页选择');
            }
            outputContract = task.outputContract;
            const requestConfig: GenerateRequestConfig = {
                baseUrl: endpoint.url,
                apiKey: endpoint.key,
                model: endpoint.model,
                temperature: task.temperature,
                maxTokens: task.maxTokens,
                stream: task.stream,
                outputContract: task.outputContract,
                reasoningEffort: task.reasoningEffort,
                // 对象 schema 与提示词契约同步（顶层 {"options":[...]}）；
                // 端点对 json_schema 档的支持度实测结论见 choice/api.ts 文件头
                jsonSchema: task.outputContract === 'json_schema' ? OPTIONS_JSON_SCHEMA : undefined,
            };
            const result = await callGenerateEndpoint(assembly.messages, requestConfig, controller.signal);
            rawText = result.content;
        }

        const report = parseOptions(rawText, gen.count);
        if (report.options.length === 0) {
            throw new Error(`解析得到 0 条选项（路径 ${report.path}）——原始输出：${rawText.slice(0, 200)}`);
        }
        store.succeed(report.options, report.path, assembly.dumpText);
        // dump 落 console 一份：控制台即排障口（与 __TTK_PROMPTS__.dump 同源）
        console.info(`[tt-toolkit][choice] 生成完成：${report.options.length} 条（解析路径=${report.path}，输出契约=${outputContract}）`);
    } catch (e) {
        if (controller.signal.aborted) {
            store.fail('已取消');
        } else {
            const message = e instanceof Error ? e.message : String(e);
            store.fail(message);
            // 失败表面化（persona/nav 同款纪律）：选项条错误态＋toast＋console 各司其职
            showToast(`选项生成失败：${message}`, 'error');
            console.error('[tt-toolkit][choice] 生成失败', e);
        }
    } finally {
        activeAbort = null;
    }
}

/** 点击行为应用：fill 覆盖填入 / append 追加 / send 直接发送。 */
export function applyOption(content: string): void {
    const gen = choiceStorage.readDomain().gen;
    const behavior = gen.clickBehavior;
    if (behavior === 'send') {
        // 发送：填入后立即触发宿主发送通道；发送失败恢复输入内容
        void setAndSend(content);
        return;
    }
    if (behavior === 'append') {
        // 追加＝读当前值＋整体写回：textarea 的取值/赋值（含 input 事件
        // 派发）已封装在 host/chat——选择器逻辑不在业务侧重复第二份
        setSendTextareaValue(getSendTextareaValue() + content);
        return;
    }
    setSendTextareaValue(content);
}

async function setAndSend(content: string): Promise<void> {
    setSendTextareaValue(content);
    try {
        await sendInputMessage();
    } catch (e) {
        // 发送被拦截/失败：恢复为纯正文，不留半截状态
        setSendTextareaValue(content);
        console.error('[tt-toolkit][choice] 发送失败', e);
    }
}
