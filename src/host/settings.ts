/**
 * TT 宿主设置/聊天元数据读写适配。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - `script.js:775` 导出 `chat_metadata = {}`（当前聊天的元数据对象，
 *   可变单例，直接挂扩展命名空间子对象）。
 * - `script.js:805` 导出 `saveSettingsDebounced(loopCounter = 0)`（全局
 *   settings 的防抖落盘）。
 * - `script.js:670/675` 导出 `characters`（角色卡数组）与 `this_chid`
 *   （当前角色索引——数组扫描索引，非事件驱动快照，两来源会失配，
 *   消费方须知晓口径，choice-src「绑定残留」实锤在此）。
 * - `scripts/extensions.js:172` 导出 `extension_settings`（全局扩展设置
 *   可变单例）；`:108` 导出 `saveMetadataDebounced()`；`:100` 导出
 *   `cancelDebouncedMetadataSave()`。
 * - **chat 域写入坑（extensions.js:108-130）**：saveMetadataDebounced 在
 *   调用瞬间快照 groupId/characterId，防抖到期时重新取 context 比对，
 *   变更即静默丢弃保存。因此「写入发生在切聊天前、落盘火在切聊天后」
 *   会丢。本层暴露 chatSwitchAware 写入入口，切换窗口内的写入延后到
 *   CHAT_CHANGED 事件之后落地，规避该窗口。
 */

import { chat_metadata as stChatMetadata, characters as stCharacters, saveSettingsDebounced as stSaveSettingsDebounced, this_chid as stThisChid } from '@sillytavern/script';
import { cancelDebouncedMetadataSave, extension_settings as stExtensionSettings, saveMetadataDebounced as stSaveMetadataDebounced } from '@sillytavern/scripts/extensions';
import { eventBus, event_types } from './events';

/** 全局扩展设置单例（extension_settings，宿主可变对象，禁止整体替换）。 */
export const extension_settings = stExtensionSettings;

/** 聊天元数据单例（chat_metadata，随聊天切换由宿主整体换引用）。 */
export const chat_metadata = stChatMetadata;

/** 角色卡数组与当前索引（索引口径见文件头核实记录）。 */
export const characters = stCharacters;
export const this_chid = stThisChid;

// ---------------------------------------------------------------------------
// chat 域切换窗口管理：CHAT_CHANGED 到达后短暂进入 quiet 窗口，
// 窗口内的 metadata 写入排队，窗口结束（新 chat 的 metadata 已挂稳）后
// 依次落地并统一调度保存。窗口取 0（立即）也可以，但保守给一个 tick，
// 确保读到的 chat_metadata 已是宿主切换流程挂上的新对象。
// ---------------------------------------------------------------------------
const CHAT_QUIET_WINDOW_MS = 200;
let chatQuietUntil = 0;
type PendingChatWrite = () => void;
const pendingChatWrites: PendingChatWrite[] = [];

eventBus.on(event_types.CHAT_CHANGED, () => {
    chatQuietUntil = Date.now() + CHAT_QUIET_WINDOW_MS;
    scheduleQuietDrain();
});

let quietDrainTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleQuietDrain() {
    if (quietDrainTimer !== null) return;
    quietDrainTimer = setTimeout(() => {
        quietDrainTimer = null;
        if (Date.now() < chatQuietUntil) {
            scheduleQuietDrain();
            return;
        }
        const writes = pendingChatWrites.splice(0, pendingChatWrites.length);
        for (const write of writes) write();
        if (writes.length > 0) scheduleChatSave();
    }, CHAT_QUIET_WINDOW_MS);
}

function scheduleChatSave() {
    try {
        stSaveMetadataDebounced();
    } catch (e) {
        console.error('[tt-toolkit][host] saveMetadataDebounced 调用失败', e);
    }
}

/**
 * 聊天域写入：直接改内存对象 + 调度防抖保存。
 * 切换 quiet 窗口内的写入会被排到窗口后落地（见文件头坑说明）。
 */
export function writeChatMetadata(mutate: (metadata: Record<string, unknown>) => void): void {
    const apply = () => {
        mutate(chat_metadata);
    };
    if (Date.now() < chatQuietUntil) {
        pendingChatWrites.push(apply);
        scheduleQuietDrain();
        return;
    }
    apply();
    scheduleChatSave();
}

/** 全局域写入：改内存对象 + 防抖保存全局 settings。 */
export function writeExtensionSettings(mutate: (settings: Record<string, unknown>) => void): void {
    mutate(extension_settings);
    try {
        stSaveSettingsDebounced();
    } catch (e) {
        console.error('[tt-toolkit][host] saveSettingsDebounced 调用失败', e);
    }
}

/** 放弃尚未落盘的 chat 元数据保存（宿主自身的切聊天流程会接管）。 */
export function discardPendingMetadataSave(): void {
    try {
        cancelDebouncedMetadataSave();
    } catch {
        // 缺席说明宿主版本无此导出，仅影响主动取消，不吞主流程
    }
}
