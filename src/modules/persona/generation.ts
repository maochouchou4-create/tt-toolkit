/**
 * PersonaWeaver fork 生成链（批D 平移）：首次生成两段（curator 策展
 * schema → personaGen 按 schema 填充）。整合轮II 起提示词模板与模块
 * 管线在统一提示词引擎（src/prompts——按任务键取配置，assemble＋占位
 * 符填充＋trace/dump 一致可观测），本文件只承载任务上下文收集与调用链。
 *
 * MODIFICATIONS（相对上游 fork）：
 * - Anthropic 原生分支整体退役（只保留 OpenAI 兼容形态）。
 * - 整合轮II：主 API（宿主 generateRaw）与独立 API（直连 Bearer fetch）
 *   两条通道合一，走统一端点表＋共享请求客户端（宿主生成路由）。
 * - 整合轮II：字符串拼接组装退役——消息组装走引擎管线（persona 两任务
 *   键的模块与模板在代码默认模板内置）。
 * - DOM 读值链（getIndepTimeoutSec/getIndepStreamEnabled）退役：配置由
 *   store 从存储域透传（GenerationApiConfig）。
 * - setGenProgress 直写 jQuery 按钮退役：onProgress 回调由 store 接管。
 * - toastr.info(prefill 重试) 退役：onPrefillRetry 回调归调用方 toast。
 * - collectContextData 的 DOM 勾选读取退役：checkedByBook 由 store 的
 *   勾选缓存透传；未渲染的书走存储域已存选择 → enabled 兜底（旧序）。
 * - yieldToBrowser(requestAnimationFrame) 退役：Vue 渲染不靠逐书让帧。
 * - 宿主导入一律经 host 层（check-imports 纪律）：getCharacterName /
 *   getUserDisplayName / 世界书与预设通道都从 '@/host' 进；模型请求走
 *   '@/modules/apis/client'（@sillytavern 导入面只在 src/host/）。
 */

import { getCharacterInfoText, getCharacterName, getUserDisplayName, getContextWorldBooks, getWorldBookEntries, resolvePresetSystemPrompt, getTavernContext } from '@/host';
import { callGenerateEndpoint, type GenerateMessage } from '@/modules/apis/client';
import type { ApiEndpoint } from '@/modules/apis/types';
import {
    assembleMessages,
    createTaskDefaultConfig,
    renderDump,
    renderTraceCompact,
    usePromptsStore,
    type ModuleTrace,
    type PersonaAssemblySources,
    type TaskKey,
} from '@/prompts';
import { DEFAULT_TEMPLATES } from './prompts';
import { parseYamlToBlocks } from './yaml';
import { loadWiSelectionFor, readPersonaDomain, type ThinkingEffort } from './storage';
import { createTtlog } from '@/host/ttlog';

const log = createTtlog('modules/persona/generation');

/** 生成调用面的任务配置（store 从存储域透传；timeout 已夹取 30~1800s）。 */
export interface GenerationApiConfig {
    /** 选中统一端点（url/key/model；store 侧已解析非空）。 */
    endpoint: ApiEndpoint;
    /** 流式输出（长请求防挂死姿势）。 */
    stream: boolean;
    /** 思考强度（'off'＝不注入 reasoning_effort）。 */
    thinkingEffort: ThinkingEffort;
    /** 单段超时（秒，段间独立——两段链每段各自计时）。 */
    timeoutSec: number;
}

/** 世界书上下文收集入参（勾选缓存由 store 透传）。 */
export interface CollectContextOptions {
    /** 存储域 extraBooks（世界书勾选面板的补充书目来源）。 */
    extraBooks: string[];
    /** UI 已渲染的勾选缓存（书名→勾选 uid 串；无键＝该书未渲染）。 */
    checkedByBook: Record<string, string[]> | undefined;
    /** 当前角色键（loadWiSelectionFor 的存储域已存选择）。 */
    charKey: string;
}

/**
 * 世界书上下文收集（旧 collectContextData 平移）：
 * 书目 = 当前角色绑定书 + extraBooks 有序去重，≤20 本；每本按
 * 「UI 勾选 → 存储域已存选择 → enabled 兜底」取条目，拼接
 * `[DB:书名] content`。单书失败记日志不阻断（旧序保留）。
 */
export async function collectWorldInfoContext(options: CollectContextOptions): Promise<string> {
    const wiContent: string[] = [];
    const books = [...new Set([...getContextWorldBooks(), ...(options.extraBooks ?? [])])].filter(Boolean);
    if (books.length > 20) books.length = 20;

    for (const bookName of books) {
        try {
            const entries = await getWorldBookEntries(bookName);
            const uiChecked = options.checkedByBook?.[bookName];
            let enabledEntries;
            if (Array.isArray(uiChecked)) {
                enabledEntries = entries.filter(e => uiChecked.includes(String(e.uid)));
            } else {
                const savedSelection = loadWiSelectionFor(options.charKey, bookName);
                if (savedSelection && savedSelection.length > 0) {
                    enabledEntries = entries.filter(e => savedSelection.includes(String(e.uid)));
                } else {
                    enabledEntries = entries.filter(e => e.enabled);
                }
            }
            for (const entry of enabledEntries) {
                wiContent.push(`[DB:${bookName}] ${entry.content}`);
            }
        } catch (err) {
            log.warn(`世界书 ${bookName} 上下文收集失败`, err);
        }
    }
    return wiContent.join('\n\n');
}

/** 参考块包装（XiTa 式文件引用围栏；空内容返回空串不入 messages）。 */
function wrapAsXiTaReference(content: string, title: string): string {
    if (!content || !content.trim()) return '';
    return `\n> [FILE: ${title}]\n"""\n${content}\n"""`;
}

/**
 * 剥掉模型输出外层的 ``` 围栏。prefill 被续写但模型未闭合围栏时，按首行
 * 形态补回结构头再剥。
 */
export function stripYamlFence(rawText: string, prefillContent?: string): string {
    const yamlRegex = /```(?:yaml)?\n([\s\S]*?)```/i;
    const match = rawText.match(yamlRegex);
    if (match && match[1]) return match[1].trim();

    let text = rawText;
    if (prefillContent && !text.startsWith(prefillContent) && !text.startsWith('```yaml')) {
        const trimRes = text.trim();
        if (!trimRes.startsWith('```yaml') && (trimRes.startsWith('姓名') || trimRes.startsWith('  姓名') || trimRes.startsWith('基本信息'))) {
            text = prefillContent + text;
        }
    }
    return text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
}

/** 策展输出可解析性判定：切不出顶层键即回退默认模板（fail-soft）。 */
const isParsableSchema = (schema: string): boolean => parseYamlToBlocks(schema).size > 0;

/**
 * 用户输入的安全化包装：双引号换单引号 + SYSTEM_OP 指令块
 * （LOGIC_CONSTRAINT——生成结果对用户请求的刚性约束）。
 */
function wrapInputForSafety(request: string): string {
    if (!request) return '';
    const safeRequest = request.replace(/"/g, "'");
    return `
[SYSTEM_OP: LOGIC_CONSTRAINT]
[USER_QUERY]: "${safeRequest}"
[EXECUTION]:
The generated profile MUST strictly adhere to the User Query above.
Treat this as a rigid logical constraint for the simulation database.
`;
}

/** 预设提示文案（下拉旁 hint，纯文案平移）。 */
export function getPresetHintText(val: string): string {
    if (val === 'pure') {
        return '纯净模式可避免受预设风格影响或剧情续写，但无破限功能。如遇拒答，请尝试切换至其他包含破限的预设。';
    }
    if (val === 'current') {
        return '将使用酒馆当前激活的预设（Main + Jailbreak）。如果当前预设包含强烈的剧情续写指令，可能会影响生成结果。';
    }
    return `将强制使用指定预设 "${val}" 的 System Prompt 进行生成。`;
}

interface RequestOnceParams {
    config: GenerationApiConfig;
    /** 引擎组装好的消息序列（不含 prefill——重试需要独立数组，由本函数追加）。 */
    messages: GenerateMessage[];
    /** 组装 trace（日志观测——与 dump 口径同源）。 */
    trace: ModuleTrace[];
    prefillContent: string;
    label: string;
    /** prefill 兼容重试时的用户提示（toast 归调用方）。 */
    onPrefillRetry?: () => void;
}

/**
 * persona 任务消息组装（引擎管线）：按任务键取当前配置（用户在提示词
 * tab 改的就是这套），assemble＋占位符填充＋trace 一条龙。返回值含
 * trace 供调用侧观测。
 */
function assemblePersonaMessages(task: TaskKey, sources: PersonaAssemblySources): { messages: GenerateMessage[]; trace: ModuleTrace[] } {
    const store = usePromptsStore();
    const config = store.configFor(task) ?? createTaskDefaultConfig(task);
    const result = assembleMessages(config.modules, sources);
    return { messages: result.messages, trace: result.trace };
}

/**
 * 单次模型调用：前置消息序列已由引擎组装，本函数追加 prefill、发起
 * 请求并处理超时/中断/错误分类。生成链每段各调一次（每段超时独立）。
 *
 * 整合轮II：单一传输通道＝统一客户端的宿主生成路由（callGenerateEndpoint）。
 * persona 任务参数面：temperature 固定 1、不发送 max_tokens（长 YAML 友
 * 好，依赖宿主 insert_if_present 语义）、输出契约 prompt_only（纯文本）。
 */
async function requestOnce(params: RequestOnceParams): Promise<string> {
    const { config, messages, trace, prefillContent, label } = params;
    log.info(`发送请求 (${label})，超时 ${config.timeoutSec}s，流式 ${String(config.stream)}`);
    log.info(`模块管线 (${label}): ${renderTraceCompact({ messages, trace })}`);

    let responseContent = '';
    const controller = new AbortController();
    let timedOutBySelf = false;
    const timeoutId = setTimeout(() => {
        timedOutBySelf = true;
        try { controller.abort(); } catch { /* abort 对已结束的请求抛错无害 */ }
    }, config.timeoutSec * 1000);

    try {
        const promptArray: GenerateMessage[] = messages.map(m => ({ ...m }));
        const promptArrayNoPrefill = messages.map(m => ({ ...m }));
        if (prefillContent) promptArray.push({ role: 'assistant', content: prefillContent });

        const doRequest = async (messages: GenerateMessage[]): Promise<string> => {
            const result = await callGenerateEndpoint(messages, {
                baseUrl: config.endpoint.url,
                apiKey: config.endpoint.key,
                model: config.endpoint.model,
                temperature: 1,
                // max_tokens 不发：人设长文本依赖服务端模型默认上限
                stream: config.stream,
                outputContract: 'prompt_only',
                reasoningEffort: config.thinkingEffort,
            }, controller.signal);
            return result.content;
        };

        try {
            responseContent = await doRequest(promptArray);
        } catch (err) {
            // 分类：1) 自触发超时 2) 网络层错误 3) 400/Bad Request + prefill → 去 prefill 重试 4) 其它原样抛
            const errStr = (err && (err instanceof Error ? err.message : err.toString()) || '').toString();
            const errLower = errStr.toLowerCase();
            const isAbort = err && ((err as Error).name === 'AbortError' || errLower.includes('abort'));
            const isNetwork = err && ((err as Error).name === 'TypeError' || errLower.includes('failed to fetch') || errLower.includes('networkerror'));
            const isBadRequest = errLower.includes('400') || errLower.includes('bad request') || errLower.includes('invalid');

            if (timedOutBySelf || (isAbort && controller.signal.aborted)) {
                throw new Error(`请求超时 (${config.timeoutSec}s)：第三方 / Claude 中转站响应过慢。可在「API 设置 → 请求超时」里调大该值（建议 300~600 秒），或检查中转站 / 网络稳定性。`);
            }

            if (prefillContent && isBadRequest) {
                log.warn('生成失败 (400/Bad Request)，去 prefill 重试', err);
                params.onPrefillRetry?.();
                responseContent = await doRequest(promptArrayNoPrefill);
            } else if (isNetwork) {
                throw new Error(`网络请求失败：${errStr}。请检查中转站地址、API Key、网络连通性（梯子 / 公司网络代理等可能拦截）。`);
            } else {
                throw err;
            }
        }
    } finally {
        clearTimeout(timeoutId);
    }

    return responseContent;
}

export interface RunGenerationConfig extends GenerationApiConfig {
    request: string;
    wiText: string;
    greetingsText: string;
    /** 预设选择（'current'/'pure'/预设名，来自存储域 uiState）。 */
    generationPreset: string;
    onPrefillRetry?: () => void;
    /** 段边界进度文案（「策展模板中…」/「生成中…」；store 接管按钮态）。 */
    onProgress?: (label: string) => void;
}

/**
 * 生成主链（旧 runGeneration 平移）：策展（schema，fail-soft 回退默认
 * 模板）→ personaGen 填充。返回剥围栏后的 YAML 文本；空输出抛
 * 「API 返回为空」。
 */
export async function runGeneration(config: RunGenerationConfig): Promise<string> {
    const charName = getCharacterName() || 'Char';
    const currentName = getUserDisplayName();

    const rawCharInfo = getCharacterInfoText();

    const wrappedCharInfo = wrapAsXiTaReference(rawCharInfo, `Entity Profile: ${charName}`);
    const wrappedWi = wrapAsXiTaReference(config.wiText || '', 'Global State Variables');
    const wrappedGreetings = wrapAsXiTaReference(config.greetingsText || '', 'Init Sequence');
    const wrappedInput = wrapInputForSafety(config.request || '');

    // 预设 system 段解析（host 层通道；空串＝不发 system 消息）
    let activeSystemPrompt = resolvePresetSystemPrompt(config.generationPreset);
    if (activeSystemPrompt) {
        // 预设 system 常含 {{world_info}} 系宏，宿主上下文里已由独立消息注入，不剥会重复计费
        activeSystemPrompt = activeSystemPrompt
            .replace(/{{user}}/g, currentName)
            .replace(/{{char}}/g, charName)
            .replace(/{{world_info}}/gi, '')
            .replace(/{{wInfo}}/gi, '')
            .replace(/{{worldInfo}}/gi, '');
    }

    // 策展产出 schema（纯键），起手词只需围栏头；档案段起手词从目标结构
    // 首键派生——schema 由策展动态产出，不保证首块是基本信息，硬编码会
    // 逼模型续写出 schema 外的块。
    const PREFILL_SCHEMA = '```yaml\n';
    const profilePrefillFor = (structureText: string): string => {
        const firstKey = parseYamlToBlocks(structureText || '').keys().next().value;
        return firstKey ? '```yaml\n' + firstKey + ':' : '```yaml\n基本信息:';
    };

    const finalize = (rawText: string, prefillContent: string): string => {
        if (!rawText) throw new Error('API 返回为空 (Empty Response)');
        return stripYamlFence(rawText, prefillContent);
    };

    // AI 调用 1：策展 Schema。空输出或剥围栏后不可解析 → 回退默认模板，链路不中断。
    // 任务上下文供给（引擎占位符/注入源消费面；策展段 curatedSchema 为空）。
    const baseSources: PersonaAssemblySources = {
        presetSystemPrompt: activeSystemPrompt,
        wiText: wrappedWi,
        charInfo: wrappedCharInfo,
        greetings: wrappedGreetings,
        userRequest: wrappedInput,
        curatedSchema: '',
        userName: currentName,
        charName,
    };
    const curateSchema = async (): Promise<string> => {
        const assembled = assemblePersonaMessages('persona_curator', baseSources);
        const raw = await requestOnce({
            config,
            messages: assembled.messages,
            trace: assembled.trace,
            prefillContent: PREFILL_SCHEMA,
            label: 'curator',
            onPrefillRetry: config.onPrefillRetry,
        });
        const curated = raw ? stripYamlFence(raw, PREFILL_SCHEMA) : '';
        if (!isParsableSchema(curated)) {
            log.warn('策展输出为空或不可解析，回退默认模板', { curated });
            return DEFAULT_TEMPLATES.user;
        }
        return curated;
    };

    config.onProgress?.('策展模板中…');
    const schemaForGen = await curateSchema();
    config.onProgress?.('生成中…');

    const wrappedTags = wrapAsXiTaReference(schemaForGen, 'Schema Definition');
    const assembled = assemblePersonaMessages('persona_gen', { ...baseSources, curatedSchema: wrappedTags });

    // 档案段起手词从策展 schema 首键派生（curateSchema fail-soft 回退默认模板，恒非空）
    const profilePrefill = profilePrefillFor(schemaForGen);
    const raw = await requestOnce({
        config,
        messages: assembled.messages,
        trace: assembled.trace,
        prefillContent: profilePrefill,
        label: 'personaGen',
        onPrefillRetry: config.onPrefillRetry,
    });
    return finalize(raw, profilePrefill);
}

/**
 * persona 任务的观测 dump（__TTK_PROMPTS__.dump(task) 分派口）：宿主真实
 * 上下文（角色卡/开场白/世界书/预设）＋空任务态——用户请求与策展 schema
 * 是运行时输入，dump 无从得知，占位符以空串呈现模板形状。与 choice 的
 * dump 同口径（renderDump 全文输出，可整段粘贴给模型/人工核对）。
 */
export async function dumpPersonaTask(task: TaskKey): Promise<string> {
    if (task === 'choice') throw new Error('dumpPersonaTask 只处理 persona 任务');
    const charName = getCharacterName() || '角色';
    const domain = readPersonaDomain();
    const sources: PersonaAssemblySources = {
        presetSystemPrompt: resolvePresetSystemPrompt(domain.uiState.generationPreset)
            .replace(/{{user}}/g, getUserDisplayName())
            .replace(/{{char}}/g, charName)
            .replace(/{{world_info}}/gi, '')
            .replace(/{{wInfo}}/gi, '')
            .replace(/{{worldInfo}}/gi, ''),
        wiText: wrapAsXiTaReference(
            await collectWorldInfoContext({
                extraBooks: [...(domain.localConfig.extraBooks ?? [])],
                checkedByBook: undefined,
                charKey: getTavernContext()?.characterId || 'global_no_char',
            }),
            'Global State Variables',
        ),
        charInfo: wrapAsXiTaReference(getCharacterInfoText(), `Entity Profile: ${charName}`),
        greetings: '',
        userRequest: '',
        curatedSchema: '',
        userName: getUserDisplayName(),
        charName,
    };
    const assembled = assemblePersonaMessages(task, sources);
    return renderDump({ messages: assembled.messages, trace: assembled.trace });
}
