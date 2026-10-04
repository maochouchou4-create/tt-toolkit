/**
 * TT 宿主当前角色读取通道（批D persona 的生成上下文供给）。
 *
 * 角色数据真源判型：v2 卡的描述性字段在 char.data，v1 卡直接在顶层——
 * 消费 data.* 前必经 currentCharacterData 统一。
 * 角色卡数组与索引口径见 host/settings.ts 头注（this_chid 字符串形态、
 * 数组扫描索引非事件驱动快照，两来源会失配——与 choice 模块同口径消费）。
 */

import { characters, this_chid } from './settings';

/** 当前角色卡（未选角色返回 null）。 */
export function getCurrentCharacter(): Record<string, unknown> | null {
    const chid = Number(this_chid);
    if (!Number.isInteger(chid) || chid < 0) return null;
    const char = characters[chid] as Record<string, unknown> | undefined;
    return char && typeof char === 'object' ? char : null;
}

/** 当前角色数据（v2 char.data / v1 char 统一口径；未选角色返回 null）。 */
export function currentCharacterData(): Record<string, unknown> | null {
    const char = getCurrentCharacter();
    if (!char) return null;
    const data = char.data;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : char;
}

/** 当前角色名（未选角色返回空串）。 */
export function getCharacterName(): string {
    const name = getCurrentCharacter()?.name;
    return typeof name === 'string' ? name : '';
}

/** 角色描述性三段（Description/Personality/Scenario，生成上下文的 charInfo 块）。 */
export function getCharacterInfoText(): string {
    const data = currentCharacterData();
    if (!data) return '';
    let text = '';
    const description = data.description;
    const personality = data.personality;
    const scenario = data.scenario;
    if (typeof description === 'string' && description) text += `Description:\n${description}\n`;
    if (typeof personality === 'string' && personality) text += `Personality:\n${personality}\n`;
    if (typeof scenario === 'string' && scenario) text += `Scenario:\n${scenario}\n`;
    return text;
}

/** 开场白列表（first_mes=#0，alternate_greetings=#1..n；供「参考」分区选择）。 */
export function getCharacterGreetingsList(): Array<{ label: string; content: string }> {
    const data = currentCharacterData();
    if (!data) return [];
    const list: Array<{ label: string; content: string }> = [];
    const firstMes = data.first_mes;
    if (typeof firstMes === 'string' && firstMes) {
        list.push({ label: '开场白 #0', content: firstMes });
    }
    const alternates = data.alternate_greetings;
    if (Array.isArray(alternates)) {
        alternates.forEach((greeting, index) => {
            if (typeof greeting === 'string') {
                list.push({ label: `开场白 #${index + 1}`, content: greeting });
            }
        });
    }
    return list;
}
