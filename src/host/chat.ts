/**
 * TT 宿主聊天上下文适配：发送/填入通道、宏替换、世界书、人设、注入槽位。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - **发送通道**：script.js:2312 `sendTextareaMessage()`（async 无参、
 *   ESM 导出）——发送 #send_textarea 当前内容（内含 slash 命令解析、
 *   continue-on-send 等宿主语义）。st-context 未暴露它，走 ESM 导入。
 * - **填入通道**：宿主自身设值形态（script.js:6732 / :5500）＝
 *   `$('#send_textarea').val(text)[0].dispatchEvent(new Event('input',
 *   {bubbles:true}))`——dispatch input 事件让宿主同步按钮态/命令
 *   高亮，只写 .value 不派发会让宿主状态与显示脱钩。textarea 本体
 *   index.html:8406。
 * - **宏替换**：script.js:3787 `substituteParams(content, options={})`
 *   （ESM 导出）——{{user}}/{{char}} 等宿主宏。
 * - **人设**：scripts/power-user.js:136 `export const power_user = {`
 *   （:322 persona_description 字段；power-user.js 由 script.js:176
 *   导入，扩展侧直接从 power-user.js 取导出）。
 * - **世界书**：scripts/world-info.js:988
 *   `getWorldInfoPrompt(chat, maxContext, isDryRun, globalScanData)`
 *   （ESM 导出；chat 要求倒序数组——最新消息在前，主生成同口径；
 *   返回 worldInfoBefore/After/Examples/Depth/anBefore/anAfter 桶。本层
 *   只消费前四类；an 桶走注入槽位通道搬运——见 WorldInfoBuckets 注释）。
 * - **注入槽位表**：script.js:1021 `export let extension_prompts = {}`
 *   （:10647 setExtensionPrompt 写入 {value, position, depth, scan,
 *   role, filter}）；st-context.js:158 经 context 转发
 *   extensionPrompts。扫槽位走 context 转发（读侧单向、不占导入面），
 *   缺席按空表处理。
 */

import { sendTextareaMessage as stSendTextareaMessage, substituteParams as stSubstituteParams } from '@sillytavern/script';
import { power_user as stPowerUser } from '@sillytavern/scripts/power-user';
import { getWorldInfoPrompt as stGetWorldInfoPrompt } from '@sillytavern/scripts/world-info';
import { getChatMessages, getTavernContext } from './context';
import type { ChatMessage } from './context';

/** 宿主世界书激活扫描的上下文供给（world-info.js:988 globalScanData 子集）。 */
export interface WorldInfoScanInput {
    /** 扫描用楼层正文（倒序：最新在前——契约见文件头） */
    chatStrings: string[];
    maxContext: number;
    personaDescription: string;
    characterDescription: string;
    characterPersonality: string;
    characterDepthPrompt: string;
    scenario: string;
    creatorNotes: string;
}

/**
 * 世界书激活结果桶（world-info.js:1005-1018 返回结构的消费子集）。
 *
 * anBefore/anAfter（作者注释桶）刻意不采集：本旁路请求不消费它们，
 * 采集后弃用＝契约含糊。作者注释的搬运走外部注入槽位扫描通道
 * （listExtensionPromptSlots，见下），用户勾选后随 external_slot 注入。
 */
export interface WorldInfoBuckets {
    worldInfoBefore: string;
    worldInfoAfter: string;
    worldInfoExamples: string[];
    worldInfoDepth: Array<{ depth: number; entries: string[] }>;
}

/** 通用注入槽位条目（script.js:10648-10655 写入形态）。 */
export interface ExtensionPromptSlot {
    key: string;
    value: string;
    position: number;
    depth: number;
    scan: boolean;
    role: number;
}

/** 当前生效用户人设描述（空串＝未设置）。 */
export function getPersonaDescription(): string {
    const v = (stPowerUser as Record<string, unknown>).persona_description;
    return typeof v === 'string' ? v : '';
}

/** 宏替换（{{user}}/{{char}} 等宿主宏；宿主通道异常时原样返回）。 */
export function substituteMacros(content: string): string {
    try {
        const out = stSubstituteParams(content);
        return typeof out === 'string' ? out : content;
    } catch {
        return content;
    }
}

/** 世界书激活扫描（getWorldInfoPrompt 契约见文件头）。 */
export async function runWorldInfoScan(input: WorldInfoScanInput): Promise<WorldInfoBuckets> {
    const result = (await stGetWorldInfoPrompt(input.chatStrings, input.maxContext, false, {
        trigger: 'normal',
        personaDescription: input.personaDescription,
        characterDescription: input.characterDescription,
        characterPersonality: input.characterPersonality,
        characterDepthPrompt: input.characterDepthPrompt,
        scenario: input.scenario,
        creatorNotes: input.creatorNotes,
    })) as WorldInfoBuckets & Record<string, unknown>;
    return {
        worldInfoBefore: typeof result.worldInfoBefore === 'string' ? result.worldInfoBefore : '',
        worldInfoAfter: typeof result.worldInfoAfter === 'string' ? result.worldInfoAfter : '',
        worldInfoExamples: Array.isArray(result.worldInfoExamples) ? result.worldInfoExamples : [],
        worldInfoDepth: Array.isArray(result.worldInfoDepth)
            ? result.worldInfoDepth.map(d => ({
                depth: typeof d?.depth === 'number' ? d.depth : 0,
                entries: Array.isArray(d?.entries) ? d.entries.filter(x => typeof x === 'string') : [],
            }))
            : [],
    };
}

/** 扫宿主通用注入槽位表（extension_prompts，读取侧走 context 转发）。 */
export function listExtensionPromptSlots(): ExtensionPromptSlot[] {
    const raw = getTavernContext()?.extensionPrompts as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') return [];
    const slots: ExtensionPromptSlot[] = [];
    for (const [key, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        if (typeof v.value !== 'string') continue;
        slots.push({
            key,
            value: v.value,
            position: typeof v.position === 'number' ? v.position : 0,
            depth: typeof v.depth === 'number' ? v.depth : 0,
            scan: v.scan === true,
            role: typeof v.role === 'number' ? v.role : 0,
        });
    }
    return slots;
}

/** 输入框当前内容（#send_textarea 缺席返回空串）。 */
export function getSendTextareaValue(): string {
    const el = document.querySelector<HTMLTextAreaElement>('#send_textarea');
    return el?.value ?? '';
}

/** 填入输入框（宿主同款 val+input 事件形态，见文件头核实记录）。 */
export function setSendTextareaValue(text: string): boolean {
    const el = document.querySelector<HTMLTextAreaElement>('#send_textarea');
    if (!el) return false;
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

/** 发送输入框当前内容（sendTextareaMessage ESM 直调）。 */
export async function sendInputMessage(): Promise<void> {
    await stSendTextareaMessage();
}

/**
 * 取 N 轮聊天历史（role 三态消息）：过滤隐藏楼层（is_system——宿主
 * 隐藏真实字段，fork 实证 is_hidden 是死字段），rounds>0 取末 N*2 条
 * （一轮＝一问一答；隐藏楼层不占窗口槽位，口径对齐宿主主生成 coreChat）。
 */
export function getChatHistory(rounds: number): Array<{ role: 'user' | 'assistant'; content: string }> {
    const chat: ChatMessage[] = getChatMessages();
    const visible = chat.filter(m => !m.is_system);
    const picked = rounds > 0 ? visible.slice(-rounds * 2) : visible;
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of picked) {
        const content = String(m.mes ?? '');
        if (!content.trim()) continue;
        // 角色按消息来源（is_user）：实测统一 system 后 flash 模型不适配
        // 历史语境（fork 实证），保持原始 user/assistant
        out.push({ role: m.is_user ? 'user' : 'assistant', content });
    }
    return out;
}
