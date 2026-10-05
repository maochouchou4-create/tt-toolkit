/**
 * TT 宿主斜杠命令注册适配（nav 模块消费）。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - `scripts/slash-commands/SlashCommandParser.js:42` 导出
 *   `SlashCommandParser`（静态 commands 表 + addCommandObject）。
 *   addCommandObject 对重名命令**静默覆盖**（:77-98 addCommandObjectUnsafe
 *   直接写表不抛错）——注册前必须 pre-check，防止宿主或其他扩展的同名
 *   命令被无声替换、也防止自己重复注册。
 * - `scripts/slash-commands/SlashCommand.js` 导出 `SlashCommand`，
 *   `SlashCommand.fromProps({ name, helpString, callback })` 为官方构造
 *   入口。
 */

import { SlashCommand as StSlashCommand } from '@sillytavern/scripts/slash-commands/SlashCommand';
import { SlashCommandParser as StSlashCommandParser } from '@sillytavern/scripts/slash-commands/SlashCommandParser';

export interface SlashCommandProps {
    name: string;
    helpString: string;
    callback: (...args: unknown[]) => Promise<string> | string;
}

interface SlashCommandLike {
    fromProps(props: Record<string, unknown>): unknown;
}

interface SlashCommandParserLike {
    commands: Record<string, unknown>;
    addCommandObject(command: unknown): void;
}

const parser = StSlashCommandParser as unknown as SlashCommandParserLike;
const commandFactory = StSlashCommand as unknown as SlashCommandLike;

/**
 * 注册斜杠命令（重名安全）：同名命令已在表内时跳过并返回 false。
 * 静默覆盖坑见文件头核实记录，禁止绕过本函数直接调 addCommandObject。
 */
export function registerSlashCommand(props: SlashCommandProps): boolean {
    if (props.name in parser.commands) {
        console.warn(`[tt-toolkit][host] 斜杠命令 /${props.name} 已被注册，跳过`);
        return false;
    }
    parser.addCommandObject(commandFactory.fromProps(props as unknown as Record<string, unknown>));
    return true;
}

/** 斜令是否已注册（排障/探测用）。 */
export function isSlashCommandRegistered(name: string): boolean {
    return name in parser.commands;
}
