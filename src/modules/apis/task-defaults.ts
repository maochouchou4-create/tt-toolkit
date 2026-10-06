/**
 * 生成任务固定参数（用户拍板收敛）：两任务共用单一真相源，用户面零旋钮。
 * 各值依据：
 * - temperature 1.0：选项＝剧情可能性枚举，多样性是价值（贴合由人设锚定
 *   与 few-shot 承担）；显式发保证跨中转站一致（服务端默认值参差）。
 * - stream true：假流式端点硬需求，正常端点开了无害；用户对过程无感。
 * - reasoningEffort 'high'：本扩展请求恒 source=openai——宿主仅对白名单模型名（o1/o3/gpt-5.x 系）转发 reasoning_effort，其余**静默丢弃**（tt-application/src/services/chat_completion_service/payload/openai.rs:182-199；claude 等原生源会报错但不适用于本扩展的请求形态）；当前端点集无副作用；o 系端点自动高档（max 太费、低档思考不足）。
 * - personaTimeoutSec 600：超时是逃生阀不是性能旋钮；推理模型长思维链
 *   分钟级常见，宁长勿掐（生成中有取消通道）。
 * - choiceOutputContract 'json_object'：三家端点通吃；json_schema 档 ds
 *   官方 400，不可全局固定。
 * - max_tokens 不发（v1.5.3 拍板）：服务端默认输出上限，思维链与正文共享
 *   显式上限会掐断正文。
 */
export const TASK_DEFAULTS = {
    temperature: 1.0,
    stream: true,
    reasoningEffort: 'high',
    personaTimeoutSec: 600,
    choiceOutputContract: 'json_object',
} as const;
