/**
 * 按任务固化参数（流式/输出契约定死；defaultTemperature/defaultReasoningEffort＝
 * 任务默认档，实际值以任务档案 TaskProfile 同名字段优先）：键＝TaskId SSOT。
 *
 * 各值依据：
 * - choice 1.0：多样性＝剧情可能性枚举（推荐值，用户可调）；json_object
 *   三家端点通吃（json_schema 档 ds 官方 400）；思考高＝贴合人设与上下文。
 * - persona 1.0：沿两任务共用现值；prompt_only 纯文本契约（长 YAML 无
 *   JSON 转义面）。
 * - summary 0.7：信息压缩保真优先于多样性（choice 1.0 是枚举多样性场景，
 *   两值不共用）；思考高档（全任务同档的用户拍板口径）。
 * - summary_judge 0.2：二分类判断推荐低温减随机；json_object 结构化判定。
 * - stream true：假流式端点硬需求（GG 非流式挂死），正常端点开了无害。
 * - max_tokens 不发：服务端默认输出上限，思维链与正文共享显式上限会掐断
 *   正文（实测 deepseek-flash 2048 预算被思维链耗尽）。
 * - reasoning_effort 转发口径：出站源恒 custom（原样透传；openai 源按模型
 *   名白名单转发、白名单外静默丢弃），见 apis/client.ts 出站源注释。
 */

import type { TaskId } from '@/tasks';

export const TASK_PARAMS: Record<TaskId, {
    defaultTemperature: number;
    stream: boolean;
    outputContract: 'json_object' | 'prompt_only';
    defaultReasoningEffort: 'off' | 'low' | 'medium' | 'high';
}> = {
    choice:        { defaultTemperature: 1.0, stream: true, outputContract: 'json_object', defaultReasoningEffort: 'high' },
    persona:       { defaultTemperature: 1.0, stream: true, outputContract: 'prompt_only', defaultReasoningEffort: 'high' },
    summary_small: { defaultTemperature: 0.7, stream: true, outputContract: 'prompt_only', defaultReasoningEffort: 'high' },
    summary_big:   { defaultTemperature: 0.7, stream: true, outputContract: 'prompt_only', defaultReasoningEffort: 'high' },
    summary_judge: { defaultTemperature: 0.2, stream: true, outputContract: 'json_object', defaultReasoningEffort: 'high' },
};

/** persona 超时（逃生阀非性能旋钮）：推理模型长思维链分钟级常见，宁长勿掐（生成中有取消通道）。 */
export const PERSONA_TIMEOUT_SEC = 600;
