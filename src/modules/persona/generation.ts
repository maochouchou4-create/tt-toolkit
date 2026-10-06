/**
 * PersonaWeaver fork 生成链：首次生成两段（curator 策展
 * schema → personaGen 按 schema 填充）。提示词模板与模块
 * 管线在统一提示词引擎（src/prompts——按任务键取配置，assemble＋占位
 * 符填充＋trace/dump 一致可观测），本文件只承载任务上下文收集与调用链。
 *
 * MODIFICATIONS（相对上游 fork）：
 * - Anthropic 原生分支整体退役（只保留 OpenAI 兼容形态）。
 * - 主 API（宿主生成路由）与独立 API（直连 Bearer fetch）
 *   两条通道合一，走统一端点表＋共享请求客户端。
 * - 字符串拼接组装退役——消息组装走引擎管线（persona 两任务
 *   键的模块与模板在代码默认模板内置）。
 * - DOM 读值链（getIndepTimeoutSec/getIndepStreamEnabled）退役：任务参数
 *   固化于 TASK_DEFAULTS，调用面只剩端点（GenerationApiConfig）。
 * - setGenProgress 直写 jQuery 按钮退役：onProgress 回调由 store 接管。
 * - toastr.info(prefill 重试) 退役：onPrefillRetry 回调归调用方 toast。
 * - collectContextData 的 DOM 勾选读取与「UI 勾选 → 存储域已存选择 →
 *   enabled 兜底」三级取条目整体退役：世界书改全量注入（绑定书全集条目
 *   拼接，无视任何条目规则），勾选/钉选域已随域形状删除。
 * - yieldToBrowser(requestAnimationFrame) 退役：Vue 渲染不靠逐书让帧。
 * - 宿主导入一律经 host 层（check-imports 纪律）：getCharacterName /
 *   getUserDisplayName / 世界书通道都从 '@/host' 进；预设影响不走 host
 *   预设解析（任务级预设已退役）——破限注入走 apis/preset-inject 传输层
 *   前缀；模型请求走 '@/modules/apis/client'（@sillytavern 导入面只在 src/host/）。
 */

import { getCharacterInfoText, getCharacterName, getUserDisplayName, getContextWorldBooks, getWorldBookEntries } from '@/host';
import { callGenerateEndpoint, type GenerateMessage } from '@/modules/apis/client';
import { TASK_DEFAULTS } from '@/modules/apis/task-defaults';
import { resolveJailbreakMessages } from '@/modules/apis/preset-inject';
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
import { createTtlog } from '@/host/ttlog';

const log = createTtlog('modules/persona/generation');

/** 外部取消（「停止」按钮）的哨兵异常——store 侧降级为取消提示，不作错误弹报。 */
export class PersonaRunCancelled extends Error {
    constructor() {
        super('已取消');
        this.name = 'PersonaRunCancelled';
    }
}

/** 生成调用面的任务配置（store 侧解析端点；任务参数固化于 TASK_DEFAULTS）。 */
export interface GenerationApiConfig {
    /** 选中统一端点（url/key/model；store 侧已解析非空）。 */
    endpoint: ApiEndpoint;
}

/**
 * 世界书上下文收集（全量注入，已拍板无截断机制）：当前会话绑定书全集
 * （getContextWorldBooks 四绑定面）逐书全量条目拼接 `[DB:书名] content`
 * ——无视条目的 enabled/关键词触发等一切规则（getWorldBookEntries 本就
 * 不滤 disabled，返回前内部消化单书装载失败返回空表，天然不阻断）。
 */
export async function collectWorldInfoContext(): Promise<string> {
    const wiContent: string[] = [];
    for (const bookName of getContextWorldBooks()) {
        const entries = await getWorldBookEntries(bookName);
        for (const entry of entries) {
            wiContent.push(`[DB:${bookName}] ${entry.content}`);
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
    /** 外部取消信号（整条两段链共用一个；段内超时与它汇入同一 abort 通道）。 */
    signal?: AbortSignal;
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
 * 单一传输通道＝统一客户端的宿主生成路由（callGenerateEndpoint）。
 * persona 任务参数面（固化于 TASK_DEFAULTS）：temperature 1、不发送
 * max_tokens（长 YAML 友好，依赖宿主 insert_if_present 语义）、输出契约
 * prompt_only（纯文本）、stream 恒开、reasoning_effort high、超时 600s。
 */
async function requestOnce(params: RequestOnceParams): Promise<string> {
    const { config, messages, trace, prefillContent, label } = params;
    const timeoutSec = TASK_DEFAULTS.personaTimeoutSec;
    log.info(`发送请求 (${label})，超时 ${timeoutSec}s，流式 ${String(TASK_DEFAULTS.stream)}`);
    // 破限注入前缀：两段各带（定调对每次请求都要在场）；原角色插最前
    const jbPrefix = resolveJailbreakMessages();
    if (jbPrefix.length > 0) log.info(`破限注入 (${label}): ${jbPrefix.length} 条前缀`);
    log.info(`模块管线 (${label}): ${renderTraceCompact({ messages, trace })}`);

    let responseContent = '';
    const controller = new AbortController();
    let timedOutBySelf = false;
    // 外部取消汇入段内 controller：一处 abort 同时命中 fetch 与超时定时器
    const onExternalAbort = () => {
        try { controller.abort(); } catch { /* abort 对已结束的请求抛错无害 */ }
    };
    if (params.signal?.aborted) throw new PersonaRunCancelled();
    params.signal?.addEventListener('abort', onExternalAbort);
    const timeoutId = setTimeout(() => {
        timedOutBySelf = true;
        try { controller.abort(); } catch { /* abort 对已结束的请求抛错无害 */ }
    }, timeoutSec * 1000);

    try {
        const promptArray: GenerateMessage[] = [...jbPrefix, ...messages].map(m => ({ ...m }));
        const promptArrayNoPrefill = [...jbPrefix, ...messages].map(m => ({ ...m }));
        if (prefillContent) promptArray.push({ role: 'assistant', content: prefillContent });

        const doRequest = async (messages: GenerateMessage[]): Promise<string> => {
            const result = await callGenerateEndpoint(messages, {
                task: 'persona',
                baseUrl: config.endpoint.url,
                apiKey: config.endpoint.key,
                model: config.endpoint.model,
                temperature: TASK_DEFAULTS.temperature,
                // max_tokens 不发：人设长文本依赖服务端模型默认上限
                stream: TASK_DEFAULTS.stream,
                outputContract: 'prompt_only',
                reasoningEffort: TASK_DEFAULTS.reasoningEffort,
            }, controller.signal);
            return result.content;
        };

        /** 错误归类（首发与 prefill 重试共用）：取消→哨兵；超时/网络→人话；其余原样抛。 */
        const classifyFailure = (err: unknown): never => {
            const errStr = (err && (err instanceof Error ? err.message : err.toString()) || '').toString();
            const errLower = errStr.toLowerCase();
            const isAbort = err && ((err as Error).name === 'AbortError' || errLower.includes('abort'));
            const isNetwork = err && ((err as Error).name === 'TypeError' || errLower.includes('failed to fetch') || errLower.includes('networkerror'));

            // 外部取消优先归类（外部 abort 也会触发 isAbort，先判它防误报超时）
            if (params.signal?.aborted) throw new PersonaRunCancelled();
            if (timedOutBySelf || (isAbort && controller.signal.aborted)) {
                throw new Error(`请求超时（${TASK_DEFAULTS.personaTimeoutSec} 秒）——中转站响应过慢或网络不稳，可稍后重试或更换端点`);
            }
            if (isNetwork) {
                throw new Error(`网络请求失败：${errStr}。请检查中转站地址、API Key、网络连通性（梯子 / 公司网络代理等可能拦截）。`);
            }
            throw err;
        };

        try {
            responseContent = await doRequest(promptArray);
        } catch (err) {
            // 分类：1) 自触发超时 2) 网络层错误 3) 400/Bad Request + prefill → 去 prefill 重试 4) 其它原样抛
            const errLower = (err && (err instanceof Error ? err.message : err.toString()) || '').toString().toLowerCase();
            const isBadRequest = errLower.includes('400') || errLower.includes('bad request') || errLower.includes('invalid');
            if (!(prefillContent && isBadRequest)) classifyFailure(err);
            log.warn('生成失败 (400/Bad Request)，去 prefill 重试', err);
            params.onPrefillRetry?.();
            try {
                responseContent = await doRequest(promptArrayNoPrefill);
            } catch (retryErr) {
                // 重试期间的超时/取消/网络错误与首发同口径归类，不裸冒泡
                classifyFailure(retryErr);
            }
        }
    } finally {
        clearTimeout(timeoutId);
        params.signal?.removeEventListener('abort', onExternalAbort);
    }

    return responseContent;
}

export interface RunGenerationConfig extends GenerationApiConfig {
    request: string;
    wiText: string;
    greetingsText: string;
    onPrefillRetry?: () => void;
    /** 段边界进度文案（「策展模板中…」/「生成中…」；store 接管按钮态）。 */
    onProgress?: (label: string) => void;
    /** 外部取消信号（「停止」按钮；贯穿两段）。 */
    signal?: AbortSignal;
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
    // 预设影响不走这里——统一走传输层破限注入（apis/preset-inject，两段各带）。
    const baseSources: PersonaAssemblySources = {
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
            signal: config.signal,
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
        signal: config.signal,
    });
    return finalize(raw, profilePrefill);
}

/**
 * persona 任务的观测 dump（__TT_TOOLKIT__.prompts.dump(task) 分派口）：宿主真实
 * 上下文（角色卡/开场白/世界书）＋空任务态——用户请求与策展 schema
 * 是运行时输入，dump 无从得知，占位符以空串呈现模板形状。与 choice 的
 * dump 同口径（renderDump 全文输出，可整段粘贴给模型/人工核对；传输层
 * 破限前缀不进 dump——实发全文以运行日志为准）。
 */
export async function dumpPersonaTask(task: TaskKey): Promise<string> {
    if (task === 'choice') throw new Error('dumpPersonaTask 只处理 persona 任务');
    const charName = getCharacterName() || '角色';
    const sources: PersonaAssemblySources = {
        wiText: wrapAsXiTaReference(
            await collectWorldInfoContext(),
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
