/**
 * PersonaWeaver fork 入口。
 *
 * 入口只走工具箱 tab（/tt-toolbox 进壳），不挂 .persona_controls_buttons_block
 * 旧按钮、不新增 DOM 锚点（已拍板）。initPersona 是两路（浏览器引导与 node
 * 冒烟）共用的唯一初始化入口——node 下宿主事件总线为冒烟存根，CHAT_CHANGED
 * 监听安装幂等无害。
 *
 * MODIFICATIONS（相对上游 PersonaWeaver fork）：
 * - callPopup 弹窗改 shell 内「人设」tab（PersonaTab.vue）。
 * - 独立 API 砍 Anthropic 原生协议，只保留 OpenAI 兼容纯 fetch 形态。
 * - 1.2s 防抖热存改显式保存点（见 store.ts 头注）。
 */
import { eventBus, event_types } from '@/host';
import { usePersonaStore } from './store';

/** CHAT_CHANGED 订阅幂等标记（浏览器/node 两路 init 都可能调用）。 */
let chatListenerInstalled = false;

/**
 * 会话感知订阅（扩展生命周期与页面同寿，监听常驻不退订；
 * idempotent 安装防双路 init 重复挂）。
 */
function installChatChangedListener(): void {
    if (chatListenerInstalled) return;
    chatListenerInstalled = true;
    eventBus.on(event_types.CHAT_CHANGED, () => {
        usePersonaStore().handleChatChanged();
    });
}

/**
 * persona 模块初始化（浏览器引导与 node 冒烟同走此入口）。
 * 幂等：重复启动只做内存态装载。
 */
export function initPersona(): void {
    usePersonaStore().init();
    installChatChangedListener();
}

export { usePersonaStore, overwritePersonaGuarded } from './store';
export { TEXT } from './strings';
export { dumpPersonaTask } from './generation';
