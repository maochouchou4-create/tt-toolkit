/**
 * TT 宿主模块的类型声明（@sillytavern/* 说明符）。
 *
 * 为什么不用 tsconfig paths 指向 TauriTavern checkout：宿主 .js 的
 * JSDoc 类型不完备（自身 checkJs 即有数百错），paths 方案会把宿主整棵
 * import 链拉进 typecheck 程序、被其类型错误传染；本仓在 host 适配层
 * 已核实真实签名（见各 host 文件头），此处按核实结论做最小声明——
 * 类型面即「适配层实际消费面」，宿主升级时 host 层核实记录同步改这里。
 *
 * 核实基线：D:\code\repos\TauriTavern\src（rewrite 施工时 HEAD）。
 */

declare module '@sillytavern/script' {
    /** script.js:775 导出的聊天元数据可变单例 */
    export let chat_metadata: Record<string, unknown>;
    /** script.js:670 导出的角色卡数组 */
    export let characters: unknown[];
    /** script.js:675 当前角色索引（数组扫描索引口径，见 host/settings.ts 头注） */
    export let this_chid: number;
    /** script.js:805 全局 settings 防抖落盘 */
    export function saveSettingsDebounced(loopCounter?: number): void;
}

declare module '@sillytavern/scripts/extensions' {
    /** extensions.js:172 全局扩展设置可变单例 */
    export const extension_settings: Record<string, unknown>;
    /** extensions.js:108 聊天元数据防抖落盘（切聊天窗口丢存坑见 host/settings.ts 头注） */
    export function saveMetadataDebounced(): void;
    /** extensions.js:100 取消未落盘的元数据保存 */
    export function cancelDebouncedMetadataSave(): void;
}

declare module '@sillytavern/scripts/events' {
    /** events.js:3 事件类型枚举（此处只声明本仓消费面，全表见宿主源码） */
    export const event_types: {
        APP_READY: string;
        APP_INITIALIZED: string;
        CHAT_CHANGED: string;
        MESSAGE_UPDATED: string;
        CHARACTER_MESSAGE_RENDERED: string;
        SETTINGS_LOADED: string;
        [key: string]: string;
    };
    /** events.js:117 全局事件总线（EventEmitter：on/once/off/emit） */
    export const eventSource: {
        on(type: string, handler: (...args: unknown[]) => void): unknown;
        once(type: string, handler: (...args: unknown[]) => void): unknown;
        off(type: string, handler: (...args: unknown[]) => void): unknown;
        emit(type: string, ...args: unknown[]): unknown;
    };
}

declare module '@sillytavern/scripts/slash-commands/SlashCommandParser' {
    /**
     * SlashCommandParser.js:42。addCommandObject 对重名命令静默覆盖
     * （addCommandObjectUnsafe 直接写表）——注册前必须 pre-check，
     * host/slash.ts 的 registerSlashCommand 已内建。
     */
    export class SlashCommandParser {
        static commands: Record<string, unknown>;
        static addCommandObject(command: unknown): void;
    }
}

declare module '@sillytavern/scripts/slash-commands/SlashCommand' {
    /** SlashCommand.js；fromProps 为官方构造入口 */
    export class SlashCommand {
        static fromProps(props: Record<string, unknown>): unknown;
    }
}

declare module '@sillytavern/scripts/st-context' {
    /** st-context.js:121 宿主上下文（消费面子集，全量字段见宿主源码） */
    export function getContext(): {
        chat: unknown[];
        chatId: string | null;
        groupId: unknown;
        characterId: number | null;
        executeSlashCommandsWithOptions?: (command: string) => Promise<unknown>;
        [key: string]: unknown;
    } | null;
}
