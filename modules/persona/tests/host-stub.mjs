// ST 宿主桩：导出名按全仓 grep 实核的被引名给全（getContext/extensions.js、
// saveSettingsDebounced/default_user_avatar/getRequestHeaders/callPopup（script.js）、
// findPersona（utils.js）、initPersona/setUserAvatar/getUserAvatars/user_avatar（personas.js）、
// power_user（power-user.js）、createWorldInfoEntry/reloadEditor（world-info.js））。
// 测试只触纯函数路径，桩仅需可导入，不模拟宿主行为。
export function getContext() {
    return {};
}

export function saveSettingsDebounced() {
    return Promise.resolve();
}

export const default_user_avatar = 'img/user-default.png';

export function getRequestHeaders() {
    return {};
}

export function findPersona() {
    return undefined;
}

export async function initPersona() {}

export async function setUserAvatar() {}

export async function getUserAvatars() {
    return [];
}

export let user_avatar = '';

export const power_user = {
    personas: {},
    persona_descriptions: {},
    persona_description: '',
    persona_description_lorebook: '',
};

export function callPopup() {
    return Promise.resolve("");
}

export function createWorldInfoEntry() {
    return undefined;
}

export function reloadEditor() {}
