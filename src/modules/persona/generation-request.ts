/**
 * persona 生成链的单次调用面：追加起手词、发起请求、错误分类与去 prefill
 * 重试。
 *
 * 为什么独立成面（相对原 generation.ts 内联）：这条面是整仓唯一碰「一段
 * 一次调用」生命周期的地方（起手词的捆绑契约、取消的分流、400 家族去
 * prefill 重试的能力学习链），生成链编排与其无关——编排只决定调哪一段、
 * 带不带起手词、失败怎么归并。日志前缀沿用 modules/persona/generation：
 * 排障按前缀认行，改前缀等于改观测口径。
 *
 * 超时不在本层：段内超时由传输层守卫按 config.timeoutSec 负责（它本就
 * 合并外部信号）。本层再装一个同档位守卫时，外层先创建先到点，abort 汇入
 * 内层的 external 监听，内层 guard 自认「不是自己到点」→人话超时文案被
 * 换成裸 abort 上抛。到点判定只能有一处，否则「是谁到点」永远答错。
 */

import { callGenerateEndpoint, RequestTimeoutError, type GenerateMessage } from '@/modules/apis/client';
import { TASK_PARAMS } from '@/modules/apis/task-defaults';
import { routeToRequestConfig, type TaskRoute } from '@/modules/apis/task-profiles';
import { renderTraceCompact, type ModuleTrace } from '@/prompts';
import { createTtlog } from '@/host/ttlog';

const log = createTtlog('modules/persona/generation');

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

export interface RequestOnceParams {
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
 * 单次模型调用：前置消息序列已由引擎组装，本函数追加 prefill、发起
 * 请求并处理超时/中断/错误分类。生成链每段各调一次（每段超时独立）。
 *
 * 单一传输通道＝统一客户端的宿主生成路由（callGenerateEndpoint）。
 * persona 任务参数面由 routeToRequestConfig 组装：温度/思考强度随任务档案
 * 带出（缺席＝默认档）、不发 max_tokens（长 YAML 友好，依赖宿主
 * insert_if_present 语义）、输出契约 prompt_only（纯文本）、stream 恒开、
 * 超时 600s（任务固化档）。
 *
 * 超时与取消在本层是两个事实，但只归类其中一个：**超时由传输层守卫判**（到点
 * 转 RequestTimeoutError 再上抛），本层把这类错误原样透传；外部取消由本层
 * 降级成「已取消」轻提示。两者到点先后同时成立时按**到点优先**（与 choice
 * 同一口径）：用户在毫秒内先看到的若是「已取消」，而他没按过任何东西。
 */
export async function requestOnce(params: RequestOnceParams): Promise<string> {
    const { config, messages, trace, prefill, label } = params;
    const timeoutSec = TASK_PARAMS.persona.timeoutSec;
    log.info(`发送请求 (${label})，超时 ${timeoutSec}s，流式 ${String(TASK_PARAMS.persona.stream)}`);
    log.info(`模块管线 (${label}): ${renderTraceCompact({ messages, trace })}`);

    let responseContent = '';
    // 已中止的外部信号直接判死：不进请求（本轮的收集/组装段已耗掉的等待
    // 正是用户在此期间点的停止）
    if (params.signal?.aborted) throw new PersonaRunCancelled();
    // 破限前缀由传输层自动前置（client composeOutbound）；prefill 由
    // 调用方追加尾部，重试需要无 prefill 的独立数组。段内超时归传输层
    // 守卫（与 choice 同一口径），本层不再自装同档位的第二个守卫。
    const promptArray: GenerateMessage[] = prefill
        ? [...messages, { role: 'assistant', content: prefill.content }]
        : messages;
    const promptArrayNoPrefill: GenerateMessage[] = messages;

    const doRequest = async (messages: GenerateMessage[]): Promise<string> => {
        const result = await callGenerateEndpoint(
            messages,
            routeToRequestConfig('persona', config.route),
            params.signal,
        );
        return result.content;
    };

    /** 错误归类（首发与 prefill 重试共用）：到点→原样透传；取消→哨兵；
     *  网络→人话；其余原样抛。 */
    const classifyFailure = (err: unknown): never => {
        // 到点优先于取消：传输层已把「自己到点」判成人话超时错误，若它与外部
        // 取消同时成立（取消先到、到点随后落在同一请求窗口内），先判 aborted
        // 会把一次真实超时报成「已取消」——用户没按过任何东西。
        if (err instanceof RequestTimeoutError) throw err;
        const errStr = (err && (err instanceof Error ? err.message : err.toString()) || '').toString();
        const errLower = errStr.toLowerCase();
        const isNetwork = err && ((err as Error).name === 'TypeError' || errLower.includes('failed to fetch') || errLower.includes('networkerror'));

        // 外部取消归类（timedOut=false 时的裸 AbortError 落这里）
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

    return responseContent;
}
