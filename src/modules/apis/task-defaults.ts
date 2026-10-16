/**
 * 按任务固化参数（流式/输出契约定死；defaultTemperature/defaultReasoningEffort＝
 * 任务默认档，实际值以任务档案 TaskProfile 同名字段优先）：键＝TaskId SSOT。
 *
 * 各值依据：
 * - choice 1.0：多样性＝剧情可能性枚举（推荐值，用户可调）；json_object
 *   三家端点通吃（json_schema 档 ds 官方 400）；思考高＝贴合人设与上下文。
 * - persona 1.0：沿两任务共用现值；prompt_only 纯文本契约（长 YAML 无
 *   JSON 转义面）。
 * - stream true：假流式端点硬需求（GG 非流式挂死），正常端点开了无害。
 * - timeoutSec：逃生阀（不是性能旋钮），见各值旁注。
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
    timeoutSec: number;
}> = {
    // 超时＝保护上限（防死端点把请求挂到浏览器上限、界面既不能停也不报错），
    // 不是性能目标：取到点＝可见失败（传输层报错进 runlog，任务层再 toast）。
    // choice 300s：选项生成单轮、输出短（json_object 契约），但推理模型的
    // 思维链与正文共享输出预算，长端点尾延迟拉到分钟级并不罕见；宁可多等，
    // 也不把一次正常的长尾生成掐成失败。仓内无先例数值可抄（persona 那档是
    // 为长 YAML 定的），此处取两档之间的宽裕值：它只保证「不永挂」。
    choice:        { defaultTemperature: 1.0, stream: true, outputContract: 'json_object', defaultReasoningEffort: 'high', timeoutSec: 300 },
    // persona 600s：推理模型长思维链分钟级常见，宁长勿掐（生成中有取消通道，
    // 且每段各自计时，不会连乘）。
    persona:       { defaultTemperature: 1.0, stream: true, outputContract: 'prompt_only', defaultReasoningEffort: 'high', timeoutSec: 600 },
};
