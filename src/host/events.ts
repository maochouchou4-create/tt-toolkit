/**
 * TT 宿主事件总线适配（@sillytavern 导入的唯一合法层之一）。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - `scripts/events.js:3` 导出 `event_types`（枚举表：APP_READY='app_ready'、
 *   CHAT_CHANGED='chat_id_changed'、MESSAGE_UPDATED='message_updated'、
 *   CHARACTER_MESSAGE_RENDERED='character_message_rendered'、
 *   SETTINGS_LOADED='settings_loaded' 等全表见该文件）。
 * - `scripts/events.js:117` 导出 `eventSource = new EventEmitter([...])`。
 *   EventEmitter（lib/eventemitter.js）真实 API 面只有
 *   on/once/makeLast/makeFirst/removeListener/emit/emitAndWait——
 *   没有 off，摘除监听的方法名是 removeListener（eventemitter.js:114）。
 * - 事件名从这里转发导出而不在业务侧写字面量，防止枚举值漂移。
 * - 批C 补核：`scripts/events.js:9` `MESSAGE_RECEIVED: 'message_received'`。
 *   emit 形态两参 `(messageId: number, type: string)`：主生成路径
 *   `script.js:4742/4774` `await eventSource.emit(event_types.MESSAGE_RECEIVED,
 *   this.messageId, this.type)`；分组消息走 (chat_id, type)
 *   （script.js:8249/8279/8306/8361）；另有 'first_message'（script.js:9342/
 *   11824）、'command'（slash-commands.js:6117/6125）、'extension' 等类型值。
 *   type='quiet' 真实存在（script.js:3914 Generate('quiet') 及 5407/5497/
 *   5505/5544 分支），且会经 4742 正常 emit——静默生成不触发自动出选项。
 *   emit 后宿主紧接 finalizeMessageContent→CHARACTER_MESSAGE_RENDERED：
 *   emit 串行 await 每个监听器，监听器里 await 重活会推迟正文渲染
 *   （自动生成监听必须 fire-and-forget，见 modules/choice/auto.ts）。
 */

import { eventSource as stEventSource, event_types as stEventTypes } from '@sillytavern/scripts/events';

/** 事件类型枚举的转发视图：只暴露本扩展实际消费的事件。 */
export const event_types = {
    APP_READY: stEventTypes.APP_READY,
    CHAT_CHANGED: stEventTypes.CHAT_CHANGED,
    MESSAGE_UPDATED: stEventTypes.MESSAGE_UPDATED,
    MESSAGE_RECEIVED: stEventTypes.MESSAGE_RECEIVED,
    CHARACTER_MESSAGE_RENDERED: stEventTypes.CHARACTER_MESSAGE_RENDERED,
    SETTINGS_LOADED: stEventTypes.SETTINGS_LOADED,
} as const;

export type EventTypeName = (typeof event_types)[keyof typeof event_types];

type EventHandler = (...args: unknown[]) => void;

/** 宿主 EventEmitter 的真实 API 面（核实记录见文件头）。 */
interface EventEmitterLike {
    on(type: string, handler: EventHandler): void;
    once(type: string, handler: EventHandler): void;
    makeLast(type: string, handler: EventHandler): void;
    makeFirst(type: string, handler: EventHandler): void;
    removeListener(type: string, handler: EventHandler): void;
    emit(type: string, ...args: unknown[]): Promise<void>;
    emitAndWait(type: string, ...args: unknown[]): void;
}

/**
 * 事件订阅的窄接口：宿主 EventEmitter 的完整面不需要暴露，
 * 业务侧只允许订阅（emit 是宿主特权，扩展反向 emit 会伪造宿主状态；
 * 摘除监听的 removeListener 暂无消费方，需要时再入此 Pick）。
 */
export const eventBus: Readonly<Pick<EventEmitterLike, 'on' | 'once'>> =
    stEventSource as unknown as EventEmitterLike;
