/**
 * 前情摘要注入槽的挂载面：register／clear／resync。
 *
 * 常量为宿主枚举的字面量锚（不新增 @sillytavern 导入——槽写入走 host
 * 层 writeExtensionPromptSlot 的 context 转发通道，位置/角色枚举见
 * TauriTavern src/scripts/extension-prompts.js:4-17；深度取宿主
 * MAX_INJECTION_DEPTH（script.js:881）——IN_CHAT 深度超楼数＝落在全部
 * 历史之上；清位形态照 authors-note.js:353 先例（position=-1）。
 * scan=true＝拍板项：摘要文本进世界书关键词扫描语料
 * （world-info.js:4962-4968 消费锚）。
 */

import { writeExtensionPromptSlot } from '@/host';
import { readSummaryChatState } from './settings';
import { composeSlotValue } from './slot-compose';

/** 槽位 key（宿主 extensionPrompts 表内本扩展的槽名；字面量仅此一份）。 */
export const SLOT_KEY = 'tt_toolkit_summary';

const POSITION_IN_CHAT = 1; // extension-prompts.js:7
const ROLE_SYSTEM = 0;      // extension-prompts.js:15
const SLOT_DEPTH = 10000;   // MAX_INJECTION_DEPTH（script.js:881）
const POSITION_NONE = -1;   // 清位（authors-note.js:353 先例）

/** 清槽（空 value＋NONE 位——宿主按空处理，槽不进注入与扫描语料）。 */
export function clearSummarySlot(): void {
    writeExtensionPromptSlot({ key: SLOT_KEY, value: '', position: POSITION_NONE, depth: SLOT_DEPTH });
}

/** 按给定文本挂槽（空文本＝转清槽——空串不该以 IN_CHAT 位注册）。 */
export function mountSummarySlot(value: string): void {
    if (value.trim() === '') {
        clearSummarySlot();
        return;
    }
    writeExtensionPromptSlot({ key: SLOT_KEY, value, position: POSITION_IN_CHAT, depth: SLOT_DEPTH, scan: true, role: ROLE_SYSTEM });
}

/**
 * 按当前聊天总结态重挂槽（成功落账后／CHAT_CHANGED 后调用）。两者皆空
 * ＝清槽——槽生命周期与聊天绑定，切换后残留上一聊天的摘要＝串味。
 */
export function resyncSummarySlot(): void {
    const state = readSummaryChatState();
    mountSummarySlot(composeSlotValue({ bigSummary: state.bigSummary, smalls: state.smallSummaries }));
}
