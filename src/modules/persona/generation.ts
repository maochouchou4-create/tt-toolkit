/**
 * PersonaWeaver fork 生成链：首次生成三段（curator 策展 schema →
 * personaGen 按 schema 填充 → 档案整份复核）。提示词模板与模块
 * 管线在统一提示词引擎（src/prompts——按任务键取配置，assemble＋占位
 * 符填充＋trace/dump 一致可观测），本文件只承载任务上下文收集与调用链。
 *
 * MODIFICATIONS（相对上游 fork）：
 * - Anthropic 原生分支整体退役（只保留 OpenAI 兼容形态）。
 * - 主 API（宿主生成路由）与独立 API（直连 Bearer fetch）
 *   两条通道合一，走统一端点表＋共享请求客户端。
 * - 字符串拼接组装退役——消息组装走引擎管线（persona 两任务
 *   键的模块与模板在代码默认模板内置）。
 * - DOM 读值链（getIndepTimeoutSec/getIndepStreamEnabled）退役：调用面只剩
 *   任务路由（GenerationApiConfig）。
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
import { callGenerateEndpoint, isBlankResponseContent, startRequestTimeout, type GenerateMessage } from '@/modules/apis/client';
import { resolveJailbreakMessages } from '@/modules/apis/preset-inject';
import { TASK_PARAMS } from '@/modules/apis/task-defaults';
import { routeToRequestConfig, type TaskRoute } from '@/modules/apis/task-profiles';
import {
    assembleMessages,
    assemblePersonaReviewMessages,
    createTaskDefaultConfig,
    renderDump,
    renderTraceCompact,
    usePromptsStore,
    type ModuleTrace,
    type PersonaAssemblySources,
    type TaskKey,
} from '@/prompts';
import { DEFAULT_TEMPLATES } from './prompts';
import { applyReviewVerdict, ReviewUnusableError, type ReviewBrief } from './review';
import { analyzeCatalogDrift } from './redundancy';
import { checkProfileShape, isSchemaSkeleton, parseYamlToBlocks } from './yaml';
import { TEXT } from './strings';
import { PERSONA_BLOCK_CATALOG, isSkeletonLeaf } from '@/modules/persona/catalog';
import { createTtlog } from '@/host/ttlog';

const log = createTtlog('modules/persona/generation');

/**
 * 起手词围栏（全模块唯一定义）：策展段起手词、档案段首键起手词、以及剥
 * 围栏时的「模型有没有把起手词带回来」判据都从它派生。三处各写一份字面
 * 量时，围栏形态一改就会静默漏判补回——补回首行判错不报错，只把坏结构
 * 送进下一段。
 */
const PREFILL_FENCE = '```yaml';

/** 策展段起手词：只要围栏头（schema 的全部块键由模型自己续写）。 */
const PREFILL_SCHEMA = PREFILL_FENCE + '\n';

/**
 * 回退骨架（目录骨架标记的推导物）＋出厂自断言：它必须自身是一份可解析
 * 的骨架，且每个块键、每个叶键都在策展目录里。策展失败时链路由这份骨架
 * 兜底，骨架坏了却照发＝用户拿到一份结构错的档案且全程无报错；自断言把
 * 这层拦在出厂，不推给冒烟去发现。
 */
const SKELETON_FALLBACK = ((): string => {
    const skeleton = DEFAULT_TEMPLATES.user;
    const blocks = parseYamlToBlocks(skeleton);
    const catalogLeaves = new Map(
        PERSONA_BLOCK_CATALOG.map(b => [b.name, new Set(b.leaves.filter(isSkeletonLeaf).map(l => l.name))]),
    );
    const outside = [...blocks].flatMap(([block, body]) => {
        const known = catalogLeaves.get(block);
        const keys = (body.match(/^\s+(\S+):/gm) ?? []).map(k => k.trim().replace(/:$/, ''));
        if (!known) return [`块「${block}」不在目录里`];
        // 双向：解出来的键在目录里，且目录里该块标了骨架的叶一个不少地解了出来。
        // 只判前者时，键行正则切不出的叶（名字带 -／：）会整行丢掉、断言照样绿，
        // 而那正是骨架缺叶——模型拿到的是一份比目录少的档案，全程无报错。
        const missing = keys.length !== known.size
            ? [`块「${block}」解出 ${keys.length} 键 ≠ 目录骨架叶 ${known.size} 个`]
            : [];
        return [...missing, ...keys.filter(k => !known.has(k)).map(k => `叶「${block}·${k}」不在目录里`)];
    });
    if (!isSchemaSkeleton(skeleton) || blocks.size === 0 || outside.length > 0) {
        throw new Error(`回退骨架自断言未过：${outside.join('、') || '骨架不可解析或无块'}`);
    }
    return skeleton;
})();

/** 外部取消（「停止」按钮）的哨兵异常——store 侧降级为取消提示，不作错误弹报。 */
export class PersonaRunCancelled extends Error {
    constructor() {
        super('已取消');
        this.name = 'PersonaRunCancelled';
    }
}

/** 生成调用面的任务配置（store 侧经任务路由解析；温度/思考强度随档案带出）。 */
export interface GenerationApiConfig {
    /** 任务出站路由（url/key/model/temperature/reasoningEffort；store 侧已解析非空）。 */
    route: TaskRoute;
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
    // ⚠️ 这五处判据（起手词在场／首行已含起手词／首行不是围栏／trim 后
    // 不是围栏／三段首行白名单）必须同批看：漏判任一处的后果是静默的
    // ——把已经带头的正文再拼一次，拼出「```yaml基本信息: 姓名: …」这种
    // 坏结构，全程不报错。
    if (prefillContent && !text.startsWith(prefillContent) && !text.startsWith(PREFILL_FENCE)) {
        const trimRes = text.trim();
        if (!trimRes.startsWith(PREFILL_FENCE) && resumesPrefillHead(trimRes, prefillContent)) {
            text = prefillContent + text;
        }
    }
    return text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
}

/**
 * 首行是否像「起手词之后该接上的那一行」：块键段取自起手词本身（档案段
 * 的起手词按 schema 首块拼，那一段就必须是那个块名，写死会在首块改名后
 * 判错），叶行两段是续写落在叶上的两种形态——顶格与两格缩进。
 */
function resumesPrefillHead(trimmed: string, prefillContent: string): boolean {
    const prefillBlockKey = prefillContent.startsWith(PREFILL_FENCE)
        ? prefillContent.slice(PREFILL_FENCE.length + 1).replace(/:$/, '')
        : '';
    // 块键切不出东西＝起手词只有围栏头（策展段就是这种起手词：schema 的
    // 全部块键由模型自己续写，起手词里本来就没有块键可比）。这种起手词
    // 之后模型必然是从围栏头接着写下去的，所以这一支恒真是有意的：把
    // 空串交给 startsWith 会让块键判据整段空转，写成显式分支是让「恒真」
    // 与「这里根本没有块键可比」在代码里分得开，改的人一眼看得见。
    if (!prefillBlockKey) return true;
    return trimmed.startsWith(prefillBlockKey)
        || trimmed.startsWith('姓名')
        || trimmed.startsWith('  姓名');
}

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
    /**
     * 本轮要模型续写的起手词（格式锚）与它的处置者，**捆成一个字段**。
     *
     * **缺席＝本轮不带起手词**：promptArray 直接等于 messages，400 去-prefill
     * 重试分支随之不可达（没有起手词可去，重试只是把同一条请求原样再发一遍）。
     *
     * 为什么捆而不拆成两个可选字段：`onUnsupported` 是「端点不收 prefill」这条
     * 能力记忆的**唯一写入口**，而它只在该分支里被调。两个各自可选的字段里，
     * 漏传处置者编译器不报错，能力学习就静默断了（后续每个请求继续带起手词、
     * 继续吃 400、继续弹同一条提示）。捆起来之后「带起手词」这件事本身就
     * 蕴含「有人处置它的失败」，这一保证落在类型上。
     *
     * 「本轮不要格式锚」与「端点不支持 prefill」是两件事：后者是端点能力，
     * 由 `onUnsupported` 的能力记忆链承担，不因某一轮不带起手词而被绕开。
     */
    prefill?: {
        content: string;
        /** 去 prefill 重试才成功＝端点不收续写的实锤；写能力记忆与提示归组合根。 */
        onUnsupported: () => void;
    };
    label: string;
    /**
     * 去 prefill 重试时的用户提示（toast 归调用方；只在该分支里被调，故不进
     * prefill 那一捆——它是可省的 UI 钩子，没有「必须有人写」的记忆面，捆进去
     * 只会逼调用点补一个空函数）。
     */
    onPrefillRetry?: () => void;
    /** 外部取消信号（整条三段链共用一个；段内超时与它汇入同一 abort 通道）。 */
    signal?: AbortSignal;
}

/**
 * persona 侧的任务键（收窄掉 choice）：本模块只组装/导出 persona 两段，
 * 放 choice 在这里是给「恒不可达的分支」留位置——键写进签名后编译器就会
 * 把误接挡住，那段抛错守卫随之没有存在面。
 */
type PersonaTaskKey = Exclude<TaskKey, 'choice'>;

/**
 * persona 任务消息组装（引擎管线）：按任务键取当前配置（用户在提示词
 * tab 改的就是这套），assemble＋占位符填充＋trace 一条龙。返回值含
 * trace 供调用侧观测。
 */
function assemblePersonaMessages(task: PersonaTaskKey, sources: PersonaAssemblySources): { messages: GenerateMessage[]; trace: ModuleTrace[] } {
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
 * persona 任务参数面由 routeToRequestConfig 组装：温度/思考强度随任务档案
 * 带出（缺席＝默认档）、不发 max_tokens（长 YAML 友好，依赖宿主
 * insert_if_present 语义）、输出契约 prompt_only（纯文本）、stream 恒开、
 * 超时 600s（任务固化档）。
 *
 * 超时与取消在本层是两个事实：超时由传输层的守卫到点触发并转成
 * RequestTimeoutError 上抛，外部取消汇入同一中止通道但由本层降级成
 * 「已取消」轻提示——两者的用户在屏幕上的反应必须分开。
 */
async function requestOnce(params: RequestOnceParams): Promise<string> {
    const { config, messages, trace, prefill, label } = params;
    const timeoutSec = TASK_PARAMS.persona.timeoutSec;
    log.info(`发送请求 (${label})，超时 ${timeoutSec}s，流式 ${String(TASK_PARAMS.persona.stream)}`);
    log.info(`模块管线 (${label}): ${renderTraceCompact({ messages, trace })}`);

    let responseContent = '';
    // 已中止的外部信号直接判死：不进请求（本轮的收集/组装段已耗掉的等待
    // 正是用户在此期间点的停止）
    if (params.signal?.aborted) throw new PersonaRunCancelled();
    // 段内中止通道＝传输层超时守卫（外部取消汇入同一条，见 startRequestTimeout）
    const guard = startRequestTimeout(timeoutSec, params.signal);
    try {
        // 破限前缀由传输层自动前置（client composeOutbound）；prefill 由
        // 调用方追加尾部，重试需要无 prefill 的独立数组
        const promptArray: GenerateMessage[] = prefill
            ? [...messages, { role: 'assistant', content: prefill.content }]
            : messages;
        const promptArrayNoPrefill: GenerateMessage[] = messages;

        const doRequest = async (messages: GenerateMessage[]): Promise<string> => {
            const result = await callGenerateEndpoint(
                messages,
                routeToRequestConfig('persona', config.route),
                guard.signal,
            );
            return result.content;
        };

        /** 错误归类（首发与 prefill 重试共用）：取消→哨兵；网络→人话；其余原样抛
         * （到点超时已由传输层转成人话错误，见 RequestTimeoutError）。 */
        const classifyFailure = (err: unknown): never => {
            const errStr = (err && (err instanceof Error ? err.message : err.toString()) || '').toString();
            const errLower = errStr.toLowerCase();
            const isNetwork = err && ((err as Error).name === 'TypeError' || errLower.includes('failed to fetch') || errLower.includes('networkerror'));

            // 外部取消优先归类：外部 abort 与超时走同一条中止通道，先判它
            // 防把用户的取消报成端点超时
            if (params.signal?.aborted) throw new PersonaRunCancelled();
            if (isNetwork) {
                throw new Error(`网络请求失败：${errStr}。请检查中转站地址、API Key、网络连通性（梯子 / 公司网络代理等可能拦截）。`);
            }
            throw err;
        };

        try {
            responseContent = await doRequest(promptArray);
        } catch (err) {
            // 分类：1) 网络层错误 2) 400/Bad Request + 带起手词 → 去起手词重试 3) 其它原样抛
            // （到点超时在上游传输层已转成人话错误，不在本处再分类）。
            // 宿主错误信封也走本判据：信封正文保留着上游原文（含 statusCode
            // 一类字段），故 400 家族经信封路径同样命中重试（两条带起手词的
            // YAML 轮——策展段与档案段——均以 assistant 起手词结尾，被网关以
            // 「末条是模型轮」拒收正是这一族，兼容重试就是为它准备的；
            // 复核轮不带起手词，压根不进这个分支）。
            const errLower = (err && (err instanceof Error ? err.message : err.toString()) || '').toString().toLowerCase();
            const isBadRequest = errLower.includes('400') || errLower.includes('bad request') || errLower.includes('invalid');
            if (prefill && isBadRequest) {
                log.warn('生成失败 (400/Bad Request)，去 prefill 重试', err);
                params.onPrefillRetry?.();
                try {
                    responseContent = await doRequest(promptArrayNoPrefill);
                    // 去 prefill 才成功＝该端点不收 assistant 尾条的直接证据。
                    // 本链只报事件：能力记忆落档与用户提示都是调用方的
                    // 组合根职责（生成链不反写设置域），后续请求直接不带起手词。
                    // 处置者必填由 prefill 那一捆保证（带起手词必带处置者）。
                    prefill.onUnsupported();
                } catch (retryErr) {
                    // 重试期间的超时/取消/网络错误与首发同口径归类，不裸冒泡
                    classifyFailure(retryErr);
                }
            } else {
                classifyFailure(err);
            }
        }
    } finally {
        guard.dispose();
    }

    return responseContent;
}

export interface RunGenerationConfig extends GenerationApiConfig {
    request: string;
    wiText: string;
    greetingsText: string;
    onPrefillRetry?: () => void;
    /**
     * 去 prefill 重试成功后的「端点不收 prefill」事件处置（必填＝不设默认
     * no-op：能力记忆落档与用户提示都是跨域副作用，漏接＝能力永不再学且
     * 用户无感知；必填把漏接挡在编译期）。
     */
    onPrefillUnsupported: () => void;
    /** 段边界进度文案（「策展模板中…」/「生成中…」；store 接管按钮态）。 */
    onProgress?: (label: string) => void;
    /** 外部取消信号（「停止」按钮；贯穿三轮）。 */
    signal?: AbortSignal;
}

interface ReviewRoundParams {
    config: GenerationApiConfig;
    /** 档案段已组装好的消息与 trace（复核轮接在它后面，不重跑那一段）。 */
    assembled: { messages: GenerateMessage[]; trace: ModuleTrace[] };
    /** 档案段的组装供给（复用同一份策展产出；只多带 profile）。 */
    sources: PersonaAssemblySources;
    /** 首轮档案：兜底值 ＋ 指令里 {{profile}} 的值。 */
    profile: string;
    onProgress?: (label: string) => void;
    signal?: AbortSignal;
}

/** 生成链的结果：最终档案 ＋ 复核简报（两者分家——见 ReviewBrief 的注释）。 */
export interface GenerationResult {
    profile: string;
    review: ReviewBrief;
}

/**
 * 复核回合（AI 调用 3）：档案段成功后**无条件**再发一轮，判定权全给模型。
 *
 * 钉死的约束在这里落地：
 *   - **只重发档案段**：复用同一份策展产出，不重跑策展——重跑会让 schema 变，
 *     指令里点名的「块.叶」随之可能不存在；
 *   - **本轮不带 prefill**：prefill 锚的是「这一轮要什么输出格式」，不是本次
 *     会话的常量。档案段要 ` ```yaml ` ＋块名的 YAML 续写，复核轮要
 *     `块.叶 → 值` 的行——给复核轮续一段 YAML 围栏起手，等于一边用起手词钉
 *     格式一边要求另一种格式，真实模型大概率被带跑、整轮落「解析不了复核
 *     结果」。**不带起手词是这一轮的决定，与端点能力无关**：端点不支持
 *     prefill 那件事由能力记忆链承担（那两条 YAML 轮仍带起手词、仍走 400
 *     去-prefill 重试），两条路径不混；
 *   - **指令并进 `messages`**：它是本轮最后一条（user）消息。顺带一条——
 *     requestOnce 的 400 去-prefill 重发用的正是同一份 messages，指令若拼进
 *     promptArray 就会随 promptArray 一起被重置掉；
 *   - **首轮结果是兜底值**：空白／超时／网络错／回复不可用，一律返回首轮档案
 *     ＋ 对应降级简报。用户等满一轮复核的代价已经付了，换来的必须是一份档案
 *     （这一保证是 settleReviewRound 的结构义务，见它的注释）；
 *   - **取消照旧上抛**：那是用户中止整轮，不是「复核没跑完」——结果框保持原值
 *     是取消通道的既有契约。
 */
async function reviewProfile(params: ReviewRoundParams): Promise<GenerationResult> {
    const { profile } = params;
    // 入口形状闸（纯诊断：它只决定脚本侧那道「无新增完全同值」本轮跑不跑，
    // **不决定这一轮发不发**——拿形状判定当复核的闸门＝把语义检出率为零的判据层
    // 重新接成触发器，redundancy.ts 的文件头明确禁这件事）。缺席要留痕。
    // 「形状能不能判」由落地层自己从这份档案派生（applyReviewVerdict 内部扫
    // before），这里只把 code 打进日志：让调用方送一份可能来自别的文本的形状
    // 进来，校验就会读着一份不相干的形状放行或翻红。
    const shape = checkProfileShape(profile);
    if (!shape.ok) {
        log.warn('复核入口：档案形状不可判定，脚本侧同值校验本轮不跑（复核照发）', {
            code: shape.code,
            topLevelBlocks: shape.topLevelBlocks,
            leafCount: shape.leafCount,
        });
    }

    params.onProgress?.('查重复核中…');
    const result = await settleReviewRound(params);
    // 目录漂移的唯一出口（挂在复核轮收尾而不是改写分支上：漂移与「有没有重复」
    // 「这一轮改没改」三件正交，挂在改写分支上则模型回「无重复」那条最常见的路
    // 没有告警——而那条路恰恰最需要它，没人改写就没人会发现目录漂了）。
    // 三条出口（改写后／判定无重复／降级回退首轮档案）都过这里，一次生成一条：
    // 降级也报，那条路的档案照样会被人存下来用，漂移照样存在。
    warnCatalogDrift(result.profile);
    return result;
}

/**
 * 复核轮本体：**组装指令 → 发请求 → 解析落地**，三步都在同一个降级 try 里。
 *
 * 收口在一个 try 是结构保证而非风格选择：这三步里任何一处抛出，若由调用方各自
 * try，用户看到的就是「档案已经生成成功，却只得到一条错误提示」——首轮档案明明
 * 就在手上，而它只在 store 的成功分支里被赋值，降级与否全看这里有没有兜住。
 * 换句话说，「复核怎么失败都有一份档案」是这一层的义务，不该靠每个 throw 点
 * 自觉。诊断（目录漂移 warn）在 try 之外，且它的入口不抛错，不参与成败。
 *
 * 异常分两类处理，界线是**异常是不是「模型那一份回执不合契约」**：
 *   - `ReviewUnusableError`：契约内唯一那型，降级文案说「解析不了复核结果」是
 *     对用户说的真话。
 *   - 其余（超时、网络、以及本模块自己的缺陷）：文案只有三档白名单，这一支落到
 *     「请求失败」那一档——对用户成立的是「这一轮没跑完，上一版结果还在」，而
 *     真正的原因连栈一起进 `log.error`。异常**不外抛**：档案已经生成成功，让它
 *     顶掉结果框是把一个可选环节的失败升级成整轮失败。
 *   - 取消照旧上抛（用户中止整轮，不是「复核没跑完」，取消通道的既有契约）。
 */
async function settleReviewRound(params: ReviewRoundParams): Promise<GenerationResult> {
    const { profile } = params;
    try {
        const reviewAssembled = assemblePersonaReviewMessages(params.sources, profile);
        const raw = await requestOnce({
            config: params.config,
            // 刻意不带起手词（见 reviewProfile 的注释）；也因此本轮不可能走
            // 400 去-prefill 重试——没有起手词可去，重试只会把同一条请求原样再发一遍。
            messages: [...params.assembled.messages, ...reviewAssembled.messages],
            trace: [...params.assembled.trace, ...reviewAssembled.trace],
            label: 'personaReview',
            signal: params.signal,
        });
        if (isBlankResponseContent(raw)) {
            log.warn('复核轮响应为空，保留首轮结果');
            return { profile, review: { kind: 'failed', reason: TEXT.REVIEW_BRIEF.FAILURE_REASON.EMPTY } };
        }
        const outcome = applyReviewVerdict(profile, raw);
        if (outcome.kind === 'none') return { profile, review: { kind: 'none' } };
        log.info(`复核改写落档案：${outcome.changedKeys.join('、')}`);
        return { profile: outcome.text, review: { kind: 'rewritten', changedKeys: outcome.changedKeys } };
    } catch (err) {
        if (err instanceof PersonaRunCancelled) throw err;
        if (err instanceof ReviewUnusableError) {
            log.warn('复核结果不可用，回滚到首轮结果', err);
            return { profile, review: { kind: 'failed', reason: TEXT.REVIEW_BRIEF.FAILURE_REASON.UNUSABLE } };
        }
        log.error('复核轮未能完成，保留首轮结果（异常带栈，不并入用户可见文案）', err);
        return { profile, review: { kind: 'failed', reason: TEXT.REVIEW_BRIEF.FAILURE_REASON.REQUEST } };
    }
}

/**
 * 目录漂移体检告警：唯一的出口是这条 warn，返回 void —— 诊断不参与成败。
 *
 * 触发只看 `catalogDriftLeaves`——「目录里存在的块下，模型写出了目录没有的叶」，
 * 处置是改目录（catalog.ts）不是改档案。`unrecognizedBlocks` 与机制挂载块的叶
 * 不计入触发：机制挂载块按该世界的原生词汇命名，那份报告的字段注释写明「永远
 * 不必补叶」，把它们算进来等于每份挂机制块的正常档案都喊一次漂移。两个计数
 * 仍打进载荷作上下文。
 *
 * 载荷只有计数与符号名，**不带档案内文**：运行日志会被用户翻，档案正文是私事。
 *
 * 入口是判据层那条**不抛错的窄通道**（analyzeCatalogDrift）：形状不可判定时它
 * 照样返回一个报告而不是抛——所以这里不需要 try，也不可能把诊断变成失败源。
 */
function warnCatalogDrift(profile: string): void {
    const report = analyzeCatalogDrift(profile);
    if (report.catalogDriftLeaves.length === 0) return;
    log.warn('目录漂移体检：目录内块里写出了目录没有的叶（查 catalog.ts 补叶，不是改档案）', {
        catalogDriftLeaves: report.catalogDriftLeaves.length,
        mechanismBlocksOutsideCatalog: report.mechanismBlocksOutsideCatalog,
        unrecognizedLeavesTotal: report.unrecognizedLeavesTotal,
        symbol: 'analyzeCatalogDrift(...).catalogDriftLeaves（src/modules/persona/redundancy.ts）',
    });
}

/**
 * 生成主链（旧 runGeneration 平移）：策展（schema，fail-soft 回退默认
 * 模板）→ personaGen 填充 → 整份复核（无条件一轮）。返回最终档案与复核
 * 简报；**空输出抛「API 返回为空」——那是档案段的事**，复核段不抛（见
 * reviewProfile）。
 */
export async function runGeneration(config: RunGenerationConfig): Promise<GenerationResult> {
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
    const profilePrefillFor = (structureText: string): string => {
        // 首键取不到（结构不可解析）时退到回退骨架的首键：骨架由目录推导，
        // 首块会随目录变，这里再写死块名就是把第二份真相源搬进起手词。
        const firstKey = parseYamlToBlocks(structureText || '').keys().next().value
            ?? parseYamlToBlocks(SKELETON_FALLBACK).keys().next().value;
        return PREFILL_FENCE + '\n' + firstKey + ':';
    };
    // 端点能力记忆门控：已标记不支持 prefill 的端点直接不发起手词（格式
    // 稳定性的代价换可用性；标记由去 prefill 重试成功自动落下，不自动翻回）。
    // 活值而非入口快照：学习发生在策展段的重试里，档案段必须接着不带起手词
    // ——入口快照会让同一轮再吃一次 400、用户再看到一条一样的提示。
    let noPrefill = config.route.noPrefill;
    const onLearnedNoPrefill = (): void => {
        noPrefill = true;
        config.onPrefillUnsupported();
    };
    const prefillFor = (prefill: string): string => (noPrefill ? '' : prefill);
    /**
     * 起手词与它的处置者捆成一捆交给 requestOnce（见 RequestOnceParams.prefill）：
     * 本轮不带起手词时整捆缺席，而不是「带一个空串的起手词」。
     */
    const prefillBundleFor = (prefill: string): RequestOnceParams['prefill'] => {
        const content = prefillFor(prefill);
        return content ? { content, onUnsupported: onLearnedNoPrefill } : undefined;
    };

    const finalize = (rawText: string, prefillContent: string): string => {
        // 空白正文也算空（isBlankResponseContent 单点判据）：上游静默拦截
        // 常回纯空白，静默成功会让用户只看到空结果框——Fail Fast 抛错。
        if (isBlankResponseContent(rawText)) throw new Error('API 返回为空 (Empty Response)');
        return stripYamlFence(rawText, prefillContent);
    };

    // AI 调用 1：策展 Schema。空输出或剥围栏后不可解析 → 回退默认模板，链路不中断。
    // 任务上下文供给（引擎占位符/注入源消费面；策展段 curatedSchema 为空）。
    // 预设影响不走这里——统一走传输层破限注入（apis/preset-inject，每轮都带）。
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
            prefill: prefillBundleFor(PREFILL_SCHEMA),
            label: 'curator',
            onPrefillRetry: config.onPrefillRetry,
            signal: config.signal,
        });
        const curated = raw ? stripYamlFence(raw, prefillFor(PREFILL_SCHEMA)) : '';
        if (!isSchemaSkeleton(curated)) {
            log.warn('策展输出为空或不可解析，回退默认模板', { curated });
            return SKELETON_FALLBACK;
        }
        return curated;
    };

    config.onProgress?.('策展模板中…');
    const schemaForGen = await curateSchema();
    config.onProgress?.('生成中…');

    const wrappedTags = wrapAsXiTaReference(schemaForGen, 'Schema Definition');
    const genSources: PersonaAssemblySources = { ...baseSources, curatedSchema: wrappedTags };
    const assembled = assemblePersonaMessages('persona_gen', genSources);

    // 档案段起手词从策展 schema 首键派生（curateSchema fail-soft 回退默认模板，恒非空）
    const profilePrefill = prefillFor(profilePrefillFor(schemaForGen));
    const raw = await requestOnce({
        config,
        messages: assembled.messages,
        trace: assembled.trace,
        prefill: prefillBundleFor(profilePrefillFor(schemaForGen)),
        label: 'personaGen',
        onPrefillRetry: config.onPrefillRetry,
        signal: config.signal,
    });

    // AI 调用 3：整份复核（无条件一轮；不带 prefill；失败降级，首轮档案兜底）。
    return reviewProfile({
        config,
        assembled,
        sources: genSources,
        profile: finalize(raw, profilePrefill),
        onProgress: config.onProgress,
        signal: config.signal,
    });
}

/**
 * persona 任务的观测 dump（__TT_TOOLKIT__.prompts.dump(task) 分派口）：宿主真实
 * 上下文（角色卡/开场白/世界书）＋空任务态——用户请求与策展 schema
 * 是运行时输入，dump 无从得知，占位符以空串呈现模板形状。与 choice 的
 * dump 同口径（消息段＝破限前缀＋组装序列，前缀经 apis/preset-inject 的
 * composeOutbound 同一实现；prefill 是每段请求的局部追加，不属组装产物，
 * 实发全文以运行日志为准）。
 */
export async function dumpPersonaTask(task: PersonaTaskKey): Promise<string> {
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
    return renderDump({ messages: assembled.messages, trace: assembled.trace }, undefined, resolveJailbreakMessages());
}
