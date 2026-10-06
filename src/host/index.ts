/**
 * host 适配层导出面：@sillytavern/* 导入的唯一合法层。
 *
 * 仓内其余模块禁止直接 import '@sillytavern/*'（check-imports.mjs
 * 对 dist 产物逐条断言 + 对源码隔离面断言）。本层职责：
 *   - 核实并固定宿主 API 的调用形态（各文件头带核实记录）；
 *   - 给业务侧提供窄接口（类型契约在此收敛，不外泄宿主宽松类型）。
 */

export { event_types, eventBus } from './events';
export type { EventTypeName } from './events';
export {
    characters,
    chat_metadata,
    extension_settings,
    this_chid,
    writeChatMetadata,
    writeExtensionSettings,
} from './settings';
export { isSlashCommandRegistered, registerSlashCommand } from './slash';
export type { SlashCommandProps } from './slash';
export { executeSlashCommand, getChatMessages, getTavernContext } from './context';
export type { ChatMessage, TavernContextLike } from './context';
export { appendWandMenuEntry, attachHostDrag, getSavedMovingUIState, hostWindow } from './dom';
export type { MovingUIStateEntry, WandMenuEntry } from './dom';
// 生成请求客户端在 src/modules/apis/client.ts（统一 API 层）；
// host 层保留请求头装配（@sillytavern 导入面不变）
export { getTavernRequestHeaders } from './headers';
export {
    getChatHistory,
    getPersonaDescription,
    getSendTextareaValue,
    listExtensionPromptSlots,
    runWorldInfoScan,
    sendInputMessage,
    setSendTextareaValue,
    substituteMacros,
    type ExtensionPromptSlot,
    type WorldInfoBuckets,
    type WorldInfoScanInput,
} from './chat';
export { createTtlog, safeText } from './ttlog';
export type { Ttlog, TtlogEntry } from './ttlog';
export { showToast } from './toast';
export type { ToastLevel } from './toast';
export { waitForResource } from './wait';
export type { WaitResourceOptions } from './wait';
export { formatProbeResults, probeHost } from './probe';
export type { ProbeResult } from './probe';
export {
    getCharacterGreetingsList,
    getCharacterInfoText,
    getCharacterName,
    getCurrentCharacter,
} from './characters';
export {
    getCurrentAvatarId,
    getUserDisplayName,
    listUserPersonas,
    upsertPersona,
    type PersonaDescriptor,
} from './personas';
export { buildPresetOptions, listOpenAIPresetNames, resolvePresetSystemPrompt } from './presets';
export {
    getContextWorldBooks,
    getWorldBookEntries,
    loadWorldInfoBook,
    upsertWorldInfoPersonaEntry,
    type WorldBookEntrySummary,
    type WorldInfoBookData,
} from './worldinfo';
