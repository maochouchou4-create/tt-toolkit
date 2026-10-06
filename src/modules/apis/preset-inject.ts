/**
 * 破限预设注入（两任务共用的生成前缀通道）。
 *
 * 选中宿主 openai 预设的「启用文本条目」按原角色插到两任务每次请求的
 * 消息序列最前（assistant 开场条目靠保住角色形态才成立，不做改写）。
 * 预设的采样参数不生效——任务参数固化于 TASK_DEFAULTS，此处只注文本。
 *
 * Fail-soft：预设被改名/删除/宿主通道缺席 → 空序列＋宿主日志 warn，
 * 生成照常（无注入）；悬空选中由 API 页「生成注入」卡显示提醒。
 */

import { readPresetInjectMessages } from '@/host';
import { createTtlog } from '@/host/ttlog';
import type { GenerateMessage } from './client';
import { readJailbreakPreset } from './storage';

const log = createTtlog('modules/apis/preset-inject');

/** 已警示过的悬空预设名（persona 两段链一发两条同文——同名只警一次）。 */
const warnedNames = new Set<string>();

/** 解析破限注入前缀（未启用/读不到 → 空序列，生成照常）。 */
export function resolveJailbreakMessages(): GenerateMessage[] {
    const name = readJailbreakPreset();
    if (!name) return [];
    const messages = readPresetInjectMessages(name);
    if (!messages) {
        if (!warnedNames.has(name)) {
            warnedNames.add(name);
            log.warn(`破限预设「${name}」不可用（不存在或无启用文本条目）——生成将不带注入`);
        }
        return [];
    }
    warnedNames.delete(name);
    return messages;
}
