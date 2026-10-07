/**
 * 宿主注入槽写入适配（script.js:10647 setExtensionPrompt 的 context
 * 转发通道，见 host/context.ts 接口锚）。本层只收敛调用形态：
 * 接收者保留（方法调用形态，unbound-method 门禁）＋缺席 fail-soft
 * （宿主版本漂移时槽写入无效但不炸——槽是增强注入，缺席不该阻断
 * 生成主链路；消费侧读不到槽位＝摘要不进上下文，观测面可见）。
 */

import { getTavernContext } from './context';

/** 写宿主通用注入槽（形态对齐 script.js:10647 {value, position, depth, scan, role}）。 */
export function writeExtensionPromptSlot(args: {
    key: string;
    value: string;
    position: number;
    depth: number;
    scan?: boolean;
    role?: number;
}): void {
    const ctx = getTavernContext();
    ctx?.setExtensionPrompt?.(args.key, args.value, args.position, args.depth, args.scan, args.role);
}
