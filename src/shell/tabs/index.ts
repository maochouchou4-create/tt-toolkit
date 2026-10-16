/**
 * 壳的功能页注册（tab 描述符）。每 tab 一个 createApp + 共享 pinia
 * （tab 契约 mount(container) 的 Vue 实现形态，后续批次的功能页照此）。
 */

import { createApp } from 'vue';
import { pinia } from '@/pinia';
import type { ShellTab } from '@/shell/types';
import { useApisStore } from '@/modules/apis/store';
import { usePersonaStore } from '@/modules/persona/store';
import ApiTab from './ApiTab.vue';
import ChoiceSettingsTab from './ChoiceSettingsTab.vue';
import LogTab from './LogTab.vue';
import PersonaTab from './PersonaTab.vue';

export function createApiTab(): ShellTab {
    return {
        id: 'api',
        tabTitle: 'API',
        mount(container) {
            const app = createApp(ApiTab);
            app.use(pinia);
            app.mount(container);
        },
        // tab 容器只挂载一次、激活只切可见——宿主侧增删 openai 预设后，
        // 破限注入卡的清单与悬空提醒靠这里每次激活刷新
        onActivate() {
            useApisStore(pinia).refreshPresetNames();
        },
    };
}

export function createChoiceSettingsTab(): ShellTab {
    return {
        id: 'choice-settings',
        tabTitle: '选项生成',
        mount(container) {
            const app = createApp(ChoiceSettingsTab);
            app.use(pinia);
            app.mount(container);
        },
    };
}

export function createPersonaTab(): ShellTab {
    return {
        id: 'persona',
        tabTitle: '人设',
        mount(container) {
            const app = createApp(PersonaTab);
            app.use(pinia);
            app.mount(container);
        },
        // 宿主派生快照（开场白/绑定书单）挂在描述符上，每次点进本 tab 刷一次：
        // tab 容器只挂载一次、激活只切可见，组件内的 onActivated 在未启用
        // KeepAlive 的壳里永不触发。只刷派生数据，结果框的编辑现场不动。
        onActivate() {
            usePersonaStore(pinia).refreshHostData();
        },
    };
}

export function createLogTab(): ShellTab {
    return {
        id: 'log',
        tabTitle: '日志',
        mount(container) {
            const app = createApp(LogTab);
            app.use(pinia);
            app.mount(container);
        },
    };
}
