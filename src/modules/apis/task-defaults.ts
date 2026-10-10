/**
 * 生成任务固定参数（用户拍板收敛）：两任务共用单一真相源，用户面零旋钮。
 * 各值依据：
 * - temperature 1.0：选项＝剧情可能性枚举，多样性是价值（贴合由人设锚定
 *   与 few-shot 承担）；显式发保证跨中转站一致（服务端默认值参差）。
 * - stream true：假流式端点硬需求，正常端点开了无害；用户对过程无感。
 * - reasoningEffort 'high'：请求走宿主 custom 源＝reasoning_effort 原样透传（openai.rs:182-186；openai 源按模型名白名单转发、白名单外静默丢弃，故出站源必须是 custom——口径见 apis/client.ts）；选项/人设要贴合人设与上下文，档位从高。
 * - personaTimeoutSec 600：超时是逃生阀不是性能旋钮；推理模型长思维链
 *   分钟级常见，宁长勿掐（生成中有取消通道）。
 * - choiceOutputContract 'json_object'：三家端点通吃；json_schema 档 ds
 *   官方 400，不可全局固定。
 * - max_tokens 不发（v1.5.3 拍板）：服务端默认输出上限，思维链与正文共享
 *   显式上限会掐断正文。
 * - summaryTemperature 0.7：总结＝信息压缩，保真优先于多样性（choice 1.0
 *   是枚举多样性场景，两值不共用）。
 * - summaryReasoningEffort 'high'：全任务同档（用户拍板）——低档省的
 *   时长有限，高档换摘要保真（转发口径同上 reasoningEffort）。
 */
export const TASK_DEFAULTS = {
    temperature: 1.0,
    stream: true,
    reasoningEffort: 'high',
    personaTimeoutSec: 600,
    choiceOutputContract: 'json_object',
    summaryTemperature: 0.7,
    summaryReasoningEffort: 'high',
} as const;
