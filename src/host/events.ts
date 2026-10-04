/**
 * TT 宿主事件总线适配（@sillytavern 导入的唯一合法层之一）。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - `scripts/events.js:3` 导出 `event_types`（枚举表：APP_READY='app_ready'、
 *   CHAT_CHANGED='chat_id_changed'、MESSAGE_UPDATED='message_updated'、
 *   CHARACTER_MESSAGE_RENDERED='character_message_rendered'、
 *   SETTINGS_LOADED='settings_loaded' 等全表见该文件）。
 * - `scripts/events.js:117` 导出 `eventSource = new EventEmitter([...])`，
 *   EventEmitter（lib/eventemitter.js）提供 on/once/off/emit。
 * - 事件名从这里转发导出而不在业务侧写字面量，防止枚举值漂移。
 */

import { eventSource as stEventSource, event_types as stEventTypes } from '@sillytavern/scripts/events';

/** 事件类型枚举的转发视图：只暴露本扩展实际消费的事件。 */
export const event_types = {
    APP_READY: stEventTypes.APP_READY,
    CHAT_CHANGED: stEventTypes.CHAT_CHANGED,
    MESSAGE_UPDATED: stEventTypes.MESSAGE_UPDATED,
    CHARACTER_MESSAGE_RENDERED: stEventTypes.CHARACTER_MESSAGE_RENDERED,
    SETTINGS_LOADED: stEventTypes.SETTINGS_LOADED,
} as const;

export type EventTypeName = (typeof event_types)[keyof typeof event_types];

type EventHandler = (...args: unknown[]) => void;

interface EventEmitterLike {
    on(type: string, handler: EventHandler): unknown;
    once(type: string, handler: EventHandler): unknown;
    off(type: string, handler: EventHandler): unknown;
}

/**
 * 事件订阅的窄接口：宿主 EventEmitter 的完整面不需要暴露，
 * 业务侧只允许订阅（emit 是宿主特权，扩展反向 emit 会伪造宿主状态）。
 */
export const eventBus: Readonly<Pick<EventEmitterLike, 'on' | 'once' | 'off'>> =
    stEventSource as unknown as EventEmitterLike;
