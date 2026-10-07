/**
 * TT 宿主模块的类型声明（@sillytavern/* 说明符）。
 *
 * 为什么不用 tsconfig paths 指向 TauriTavern checkout：宿主 .js 的
 * JSDoc 类型不完备（自身 checkJs 即有数百错），paths 方案会把宿主整棵
 * import 链拉进 typecheck 程序、被其类型错误传染；本仓在 host 适配层
 * 已核实真实签名（见各 host 文件头），此处按核实结论做最小声明——
 * 类型面即「适配层实际消费面」，宿主升级时 host 层核实记录同步改这里。
 *
 * 声明漂移防线：每条导出声明带 hostAnchor 锚点注释（宿主源码
 * file:line + 片段），scripts/check-host-anchors.mjs 解析全部锚点、读
 * 宿主 checkout 对应行、规范化空白后比对片段，漂移即 exit 1。
 *
 * 核实基线：D:\code\repos\TauriTavern\src（rewrite 施工时 HEAD）。
 */

declare module '@sillytavern/script' {
    /**
     * @hostAnchor script.js:775 export let chat_metadata = {};
     */
    export let chat_metadata: Record<string, unknown>;
    /**
     * @hostAnchor script.js:670 export let characters = [];
     */
    export let characters: unknown[];
    /**
     * 当前角色索引的字符串形态（未选角色为 undefined；索引口径见
     * host/settings.ts 头注）。
     * @hostAnchor script.js:8709 this_chid = String(value);
     */
    export let this_chid: string;
    /**
     * @hostAnchor script.js:805 export function saveSettingsDebounced(loopCounter = 0) {
     */
    export function saveSettingsDebounced(loopCounter?: number): void;
    /**
     * 发送 #send_textarea 当前内容（宿主完整发送语义：slash 解析/
     * continue-on-send；async 无参）。
     * @hostAnchor script.js:2312 export async function sendTextareaMessage() {
     */
    export function sendTextareaMessage(): Promise<void>;
    /**
     * 宏替换（{{user}}/{{char}} 等；options 形态见宿主 source）。
     * @hostAnchor script.js:3787 export function substituteParams(content, options = {}) {
     */
    export function substituteParams(content: string, options?: Record<string, unknown>): string;
    /**
     * 宿主请求头（CSRF token；生成端点调用必需）。
     * @hostAnchor script.js:1041 export function getRequestHeaders({ omitContentType = false } = {}) {
     */
    export function getRequestHeaders(options?: { omitContentType?: boolean }): Record<string, string>;
    /**
     * 宿主通用注入槽位表（可变单例；本仓只读扫描，不写）。
     * @hostAnchor script.js:1021 export let extension_prompts = {};
     */
    export let extension_prompts: Record<string, unknown>;
    /**
     * 新建用户头像时复制的宿主默认头像文件路径（host/personas.ts
     * 上传通道的 blob 来源）。
     * @hostAnchor script.js:680 export const default_user_avatar = 'img/user-default.png';
     */
    export const default_user_avatar: string;
}

declare module '@sillytavern/scripts/extensions' {
    /**
     * @hostAnchor scripts/extensions.js:172 export const extension_settings = {
     */
    export const extension_settings: Record<string, unknown>;
}

declare module '@sillytavern/scripts/events' {
    /**
     * 事件类型枚举（此处只声明本仓消费面，全表见宿主源码）。
     * @hostAnchor scripts/events.js:3 export const event_types = {
     */
    export const event_types: {
        APP_READY: string;
        APP_INITIALIZED: string;
        CHAT_CHANGED: string;
        MESSAGE_UPDATED: string;
        /** emit 形态 (messageId: number, type: string)，核实记录见 host/events.ts 头注释 */
        MESSAGE_RECEIVED: string;
        CHARACTER_MESSAGE_RENDERED: string;
        SETTINGS_LOADED: string;
        /** emit 形态 (avatarId: string)，personas.js:866 同款 */
        PERSONA_CREATED: string;
        /** emit 形态 (avatarId: string)，personas.js:871 同款（host/personas.ts 写回后触发） */
        PERSONA_UPDATED: string;
        [key: string]: string;
    };
    /**
     * EventEmitter 真实 API 面（lib/eventemitter.js）：没有 off，摘除
     * 监听的方法名是 removeListener（eventemitter.js:114）。
     * @hostAnchor scripts/events.js:117 export const eventSource = new EventEmitter([event_types.APP_READY, event_types.APP_INITIALIZED, event_types.SETTINGS_LOADED]);
     */
    export const eventSource: {
        on(type: string, handler: (...args: unknown[]) => void): void;
        once(type: string, handler: (...args: unknown[]) => void): void;
        makeLast(type: string, handler: (...args: unknown[]) => void): void;
        makeFirst(type: string, handler: (...args: unknown[]) => void): void;
        removeListener(type: string, handler: (...args: unknown[]) => void): void;
        emit(type: string, ...args: unknown[]): Promise<void>;
        emitAndWait(type: string, ...args: unknown[]): void;
    };
}

declare module '@sillytavern/scripts/slash-commands/SlashCommandParser' {
    /**
     * addCommandObject 对重名命令静默覆盖（addCommandObjectUnsafe
     * 直接写表不抛错）——注册前必须 pre-check，host/slash.ts 的
     * registerSlashCommand 已内建。
     * @hostAnchor scripts/slash-commands/SlashCommandParser.js:42 export class SlashCommandParser {
     * @hostAnchor scripts/slash-commands/SlashCommandParser.js:43 static commands = {};
     * @hostAnchor scripts/slash-commands/SlashCommandParser.js:64 static addCommandObject(command) {
     */
    export class SlashCommandParser {
        static commands: Record<string, unknown>;
        static addCommandObject(command: unknown): void;
    }
}

declare module '@sillytavern/scripts/slash-commands/SlashCommand' {
    /**
     * @hostAnchor scripts/slash-commands/SlashCommand.js:30 export class SlashCommand {
     * @hostAnchor scripts/slash-commands/SlashCommand.js:45 static fromProps(props) {
     */
    export class SlashCommand {
        static fromProps(props: Record<string, unknown>): unknown;
    }
}

declare module '@sillytavern/scripts/st-context' {
    /**
     * 宿主 openai 预设管理器（`getPresetManager('openai')` 返回的 class 实例；
     * 方法体内部走 `this`，调用方必须保留接收者——解引用后裸调会丢 this 抛错）。
     * @hostAnchor scripts/preset-manager.js:97 export function getPresetManager(apiId = '') {
     * @hostAnchor scripts/preset-manager.js:549 getPresetList(api) {
     * @hostAnchor scripts/preset-manager.js:777 getCompletionPresetByName(name) {
     */
    export interface TauriTavernPresetManager {
        getPresetList(api?: string): unknown;
        getCompletionPresetByName(name: string): unknown;
    }
    /**
     * getContext() 返回宿主上下文（此处只声明本仓消费的字段子集，
     * 全量字段见宿主源码）。
     * @hostAnchor scripts/st-context.js:121 export function getContext() {
     */
    export function getContext(): {
        /** 当前聊天全量消息数组（绝对索引即楼层号） */
        chat: unknown[];
        /** @hostAnchor scripts/st-context.js:131 chatId: selected_group */
        chatId: string | null;
        /** @hostAnchor scripts/st-context.js:130 groupId: selected_group, */
        groupId: unknown;
        /**
         * this_chid 的转发（string 形态；未选角色为 null）。
         * @hostAnchor scripts/st-context.js:129 characterId: this_chid,
         */
        characterId: string | null;
        /** @hostAnchor scripts/st-context.js:177 executeSlashCommandsWithOptions, */
        executeSlashCommandsWithOptions?: (command: string) => Promise<unknown>;
        /** 当前 chat_metadata 的立即保存通道（script.js:11175，async 无参） */
        saveMetadata?: () => Promise<unknown>;
        /**
         * 当前聊天消息变更后的立即保存通道（内部＝saveChatConditional：
         * script.js:11198 selected_group 分流，群聊安全）。
         * @hostAnchor scripts/st-context.js:161 saveChat: saveChatConditional,
         */
        saveChat?: () => Promise<unknown>;
        /**
         * power_user 的转发：movingUIState 持久化各浮层拖动位置
         * （dragElement 写入），壳挂载时自恢复读取。
         * @hostAnchor scripts/st-context.js:235 powerUserSettings: power_user,
         */
        powerUserSettings?: {
            movingUI: boolean;
            movingUIState: Record<string, Record<string, unknown>>;
        };
        /**
         * oai_settings 的转发（当前激活 openai 预设名＝
         * preset_settings_openai；persona 预设解析读取）。
         * @hostAnchor scripts/st-context.js:233 chatCompletionSettings: oai_settings,
         */
        chatCompletionSettings?: Record<string, unknown>;
        /**
         * 全量世界书名快照（persona 书目分区）。
         * @hostAnchor scripts/st-context.js:289 getWorldInfoNames: () => Array.isArray(world_names) ? [...world_names] : [],
         */
        getWorldInfoNames?: () => unknown;
        /**
         * 预设管理器转发（persona 预设清单/按名取预设）。
         * @hostAnchor scripts/st-context.js:293 getPresetManager,
         */
        getPresetManager?: (apiId: string) => TauriTavernPresetManager | null;
        [key: string]: unknown;
    } | null;
}

declare module '@sillytavern/scripts/RossAscends-mods' {
    /**
     * dragElement 是 ESM 导出函数，不是 jQuery 插件（$.fn 上没有它；
     * 宿主自身用法＝import 后调用，见 initMovingUI :681-685——曾在
     * jQuery 包装对象上找 .dragElement 导致永远走降级分支的实锤）。
     * 拖把手契约：目标元素需有 id，把手 selector 固定 #<id>header 且
     * 须带 .drag-grabber 类（:648-656 才绑 mousedown）。
     * @hostAnchor scripts/RossAscends-mods.js:498 export function dragElement($elmnt) {
     */
    export function dragElement($elmnt: unknown): void;
}

declare module '@sillytavern/scripts/power-user' {
    /**
     * 全局 power_user 单例（含 persona_description 人设字段 :322；
     * 本仓只读该字段，不写）。
     * @hostAnchor scripts/power-user.js:136 export const power_user = {
     */
    export const power_user: Record<string, unknown>;
}

declare module '@sillytavern/scripts/world-info' {
    /**
     * 世界书激活扫描（chat 需倒序数组——最新消息在前；返回
     * worldInfoBefore/After/Examples/Depth/anBefore/anAfter 桶，
     * world-info.js:1005-1018）。globalScanData 键集见
     * world-info.js:279-287 defaultGlobalScanData。
     * @hostAnchor scripts/world-info.js:988 export async function getWorldInfoPrompt(chat, maxContext, isDryRun, globalScanData) {
     */
    export function getWorldInfoPrompt(
        chat: string[],
        maxContext: number,
        isDryRun: boolean,
        globalScanData?: Record<string, unknown>,
    ): Promise<unknown>;
    /**
     * 按书名装载世界书数据（entries 键是 uid 字符串；persona
     * 的世界书条目读取通道，返回 null=书不存在）。
     * @hostAnchor scripts/world-info.js:2241 export async function loadWorldInfo(name) {
     */
    export function loadWorldInfo(name: string): Promise<{ entries: Record<string, WorldInfoEntryHost> } | null>;

    /**
     * 宿主世界书条目字段（本仓消费面子集；宽松形态见 host/worldinfo.ts 收窄）。
     * @hostAnchor scripts/world-info.js:4303 const newEntry = { uid: newUid, ...structuredClone(newWorldInfoEntryTemplate) };
     */
    export interface WorldInfoEntryHost {
        uid?: number;
        key?: unknown[];
        keysecondary?: unknown[];
        comment?: string;
        content?: string;
        disable?: boolean;
        selective?: boolean;
        order?: number;
        position?: number;
        depth?: number;
        displayIndex?: number;
        [key: string]: unknown;
    }
}

declare module '@sillytavern/scripts/personas' {
    /**
     * 当前选中用户头像 id（live binding：setUserAvatar 内部赋值，
     * personas.js:153 user_avatar = avatar）。
     * @hostAnchor scripts/personas.js:75 export let user_avatar = '';
     */
    export let user_avatar: string;
    /**
     * 头像即 persona 键：power_user.personas[avatarId]=名称。initPersona
     * 建描述符+落盘+非 silent emit PERSONA_CREATED（建档走
     * silent:true，写回纪律在 host/personas.ts）。
     * @hostAnchor scripts/personas.js:548 export async function initPersona(avatarId, personaName, personaDescription, personaTitle, {
     */
    export function initPersona(
        avatarId: string,
        personaName: string,
        personaDescription: string,
        personaTitle: string,
        options?: { silent?: boolean; position?: number; depth?: number; role?: number; lorebook?: string },
    ): Promise<void>;
    /**
     * 切换当前用户头像（toastPersonaNameChange:false 供 persona
     * 写回静默切换）。
     * @hostAnchor scripts/personas.js:168 export async function setUserAvatar(imgfile, {
     */
    export function setUserAvatar(
        imgfile: string,
        options?: { toastPersonaNameChange?: boolean; navigateToCurrent?: boolean },
    ): Promise<void>;
    /**
     * 刷新头像/persona 列表视图（ghost 键防御用它取真实文件名集）。
     * @hostAnchor scripts/personas.js:302 export async function getUserAvatars(doRender = true, openPageAt = '') {
     */
    export function getUserAvatars(doRender?: boolean, openPageAt?: string): Promise<unknown>;
}

declare module '@sillytavern/scripts/utils' {
    /**
     * 按名称查宿主 persona（upsert 写回通道用它判「已有同名档」）。
     * @hostAnchor scripts/utils.js:2724 export function findPersona({ name = null, allowAvatar = true, insensitive = true, preferCurrentPersona = true, quiet = false } = {}) {
     */
    export function findPersona(options?: {
        name?: string | null;
        allowAvatar?: boolean;
        insensitive?: boolean;
        preferCurrentPersona?: boolean;
        quiet?: boolean;
    }): unknown;
}

declare module '@sillytavern/scripts/i18n' {
    /**
     * 前端同源翻译（与 Tauri 侧同一张 locale 表——错误标签须与宿主
     * 落地正文同源，见 host/i18n.ts 头注）。
     * @hostAnchor scripts/i18n.js:122 export function translate(text, key = null) {
     */
    export function translate(text: string, key?: string): string;
}
