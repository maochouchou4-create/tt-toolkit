/**
 * TT 宿主设置/聊天元数据读写适配。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - `script.js:775` 导出 `chat_metadata = {}`（当前聊天的元数据对象，
 *   可变单例，直接挂扩展命名空间子对象）。
 * - `script.js:805` 导出 `saveSettingsDebounced(loopCounter = 0)`（全局
 *   settings 的防抖落盘）。
 * - `script.js:670/675` 导出 `characters`（角色卡数组）与 `this_chid`
 *   （当前角色索引的字符串形态——script.js:8709 setCharacterId 统一
 *   `String(value)`；数组扫描索引口径非事件驱动快照，两来源会失配，
 *   消费方须知晓口径，上游 choice 扩展「绑定残留」实锤在此）。
 * - `scripts/extensions.js:172` 导出 `extension_settings`（全局扩展设置
 *   可变单例）。
 * - `script.js:11175` `saveMetadata()`（async、无参）：把当前
 *   chat_metadata 立即入队落盘（enqueueChatSave），经
 *   `getContext().saveMetadata` 暴露（st-context.js:164）；群聊走
 *   saveGroupMetadata、未选角色时为 no-op。
 *
 * chat 域写入纪律：写入目标＝调用瞬间的当前活跃聊天——同步变更
 * chat_metadata 单例后立即调用 getContext().saveMetadata() 显式保存，
 * 无防抖、无排队、无丢弃窗口。宿主的 saveMetadataDebounced
 * （extensions.js:108-132）在 characterId/groupId 变更窗口静默丢存，
 * 且「先排队后落地」类机制会把切聊天前的写入盲落到切换后的
 * chat_metadata（A 聊天数据写进 B），本层一律不用。
 */

import { chat_metadata as stChatMetadata, characters as stCharacters, saveSettingsDebounced as stSaveSettingsDebounced, this_chid as stThisChid } from '@sillytavern/script';
import { extension_settings as stExtensionSettings } from '@sillytavern/scripts/extensions';
import { getTavernContext } from './context';

/** 全局扩展设置单例（extension_settings，宿主可变对象，禁止整体替换）。 */
export const extension_settings = stExtensionSettings;

/** 聊天元数据单例（chat_metadata，随聊天切换由宿主整体换引用）。 */
export const chat_metadata = stChatMetadata;

/** 角色卡数组与当前索引（索引口径见文件头核实记录）。 */
export const characters = stCharacters;
export const this_chid = stThisChid;

/**
 * 聊天域写入：同步变更当前 chat_metadata + 立即显式保存（机制见文件头）。
 * 保存通道缺席（宿主版本漂移）属硬错误：内存写入仍生效，但必须留下
 * console.error 线索，不许静默当作已落盘。
 */
export function writeChatMetadata(mutate: (metadata: Record<string, unknown>) => void): void {
    mutate(chat_metadata);
    const save = getTavernContext()?.saveMetadata;
    if (typeof save !== 'function') {
        console.error('[tt-toolkit][host] getContext().saveMetadata 缺席，chat 元数据仅写内存未落盘');
        return;
    }
    // saveMetadata 为 async：拒绝即保存失败，吞掉会变未处理 rejection
    void Promise.resolve(save()).catch(e => {
        console.error('[tt-toolkit][host] saveMetadata 保存失败', e);
    });
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
