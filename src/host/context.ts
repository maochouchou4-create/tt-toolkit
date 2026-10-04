/**
 * TT 宿主上下文适配（getContext 及其衍生读取）。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - `scripts/st-context.js:121` 导出 `getContext()`，返回上下文对象含
 *   chat（当前聊天全量消息数组，绝对索引即楼层号）、chatId、groupId、
 *   characterId、executeSlashCommandsWithOptions 等。
 * - `script.js:414` 挂 `globalThis.SillyTavern = { libs, getContext, i18n }`
 *   （浏览器窗口层随时可取）；node 冒烟环境走 ESM 导入同一函数。
 * - executeSlashCommandsWithOptions 在 st-context.js:177 从
 *   slash-commands.js 转发导出，为宿主斜令的权威执行器。
 */

import { getContext as stGetContext } from '@sillytavern/scripts/st-context';

export interface ChatMessage {
    mes?: string;
    role?: string;
    is_user?: boolean;
    is_system?: boolean;
    [key: string]: unknown;
}

export interface TavernContextLike {
    chat: ChatMessage[];
    chatId: string | null;
    groupId: unknown;
    characterId: number | null;
    executeSlashCommandsWithOptions?: (command: string) => Promise<unknown>;
}

/** 宿主上下文（可能为 null：无聊天打开时部分字段缺席）。 */
export function getTavernContext(): TavernContextLike | null {
    try {
        const ctx = stGetContext() as unknown as TavernContextLike | null | undefined;
        return ctx ?? null;
    } catch {
        return null;
    }
}

/** 当前聊天全量消息数组（缺席时空数组；楼层号＝数组绝对索引）。 */
export function getChatMessages(): ChatMessage[] {
    return getTavernContext()?.chat ?? [];
}

/**
 * 执行宿主斜令（如 /chat-jump）；执行器缺席返回 null 由调用方落兜底。
 * 返回值语义：成功 resolve（结果体）、失败 reject。
 */
export async function executeSlashCommand(command: string): Promise<unknown> {
    const exec = getTavernContext()?.executeSlashCommandsWithOptions;
    if (typeof exec !== 'function') {
        return null;
    }
    return await exec(command);
}
