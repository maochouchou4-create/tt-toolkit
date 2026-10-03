// ST 运行时取数适配层：角色信息 / 开场白 / 用户人格描述的唯一取数通道，供生成域与 UI 侧消费。
// SillyTavern / window / $ 为宿主全局，不经 import；getContext 与宿主数据模块
// （power_user/user_avatar）走宿主模块 import 边界。
import { getContext } from "../../../../../../extensions.js";
import { power_user } from "../../../../../../power-user.js";
import { user_avatar } from "../../../../../../personas.js";

export function getCurrentCharacter() {
    const context = getContext();
    if (context.characterId === undefined) return null;
    return context.characters[context.characterId] || null;
}

// 角色数据真源判型：v2 卡的描述性字段在 char.data，v1 卡直接在顶层——消费 data.* 前必经此统一。
export function getCurrentCharacterData() {
    const char = getCurrentCharacter();
    return char ? (char.data || char) : null;
}

// 用户显示名回退链（单一事实源）：DOM 头部名 → 备用头部名 → personas 映射显示名 → 调用方兜底。
// personas 的值本就是显示名（不是描述）；兜底值由调用方按场景传（展示空串／生成 "User"）。
export function getUserDisplayName(fallback = "User") {
    const domVal = $('.persona_name').first().text().trim();
    if (domVal) return domVal;
    const altVal = $('h5#your_name').text().trim();
    if (altVal) return altVal;
    return power_user.personas[user_avatar] || fallback;
}

export function getCharacterInfoText() {
    const data = getCurrentCharacterData();
    if (!data) return "";
    let text = "";
    if (data.description) text += `Description:\n${data.description}\n`;
    if (data.personality) text += `Personality:\n${data.personality}\n`;
    if (data.scenario) text += `Scenario:\n${data.scenario}\n`;
    return text;
}

export function getCharacterGreetingsList() {
    const data = getCurrentCharacterData();
    if (!data) return [];
    const list = [];
    if (data.first_mes) {
        list.push({ label: "开场白 #0", content: data.first_mes });
    }
    if (Array.isArray(data.alternate_greetings)) {
        data.alternate_greetings.forEach((greeting, index) => {
            list.push({ label: `开场白 #${index + 1}`, content: greeting });
        });
    }
    return list;
}

export function getActivePersonaDescription() {
    const domVal = $('#persona_description').val();
    if (domVal !== undefined && domVal !== null) return domVal;
    // 主路径＝单数镜像字段（宿主对当前选中人设持续同步，personas.js:925）；
    // 回退＝descriptor 真源。personas 映射的值是显示名不是描述（旧回退链拿错形状）。
    if (power_user.persona_description) return power_user.persona_description;
    return power_user.persona_descriptions?.[user_avatar]?.description || "";
}
