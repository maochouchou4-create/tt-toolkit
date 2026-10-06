/**
 * 壳的功能页注册（tab 描述符）。每 tab 一个 createApp + 共享 pinia
 * （tab 契约 mount(container) 的 Vue 实现形态，后续批次的功能页照此）。
 */

import { createApp } from 'vue';
import { pinia } from '@/pinia';
import type { ShellTab } from '@/shell/types';
import ApiTab from './ApiTab.vue';
import ChoiceSettingsTab from './ChoiceSettingsTab.vue';
import LogTab from './LogTab.vue';
import NavSettingsTab from './NavSettingsTab.vue';
import PersonaTab from './PersonaTab.vue';
import PoolTab from './PoolTab.vue';

export function createApiTab(): ShellTab {
    return {
        id: 'api',
        tabTitle: 'API',
        mount(container) {
            const app = createApp(ApiTab);
            app.use(pinia);
            app.mount(container);
        },
    };
}

export function createNavSettingsTab(): ShellTab {
    return {
        id: 'nav-settings',
        tabTitle: '导航',
        mount(container) {
            const app = createApp(NavSettingsTab);
            app.use(pinia);
            app.mount(container);
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
    };
}

export function createPoolTab(): ShellTab {
    return {
        id: 'pool',
        tabTitle: '条目池',
        mount(container) {
            const app = createApp(PoolTab);
            app.use(pinia);
            app.mount(container);
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
