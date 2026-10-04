/**
 * 壳的功能页注册（tab 描述符）。每 tab 一个 createApp + 共享 pinia
 * （tab 契约 mount(container) 的 Vue 实现形态，后续批次的功能页照此）。
 */

import { createApp } from 'vue';
import { pinia } from '@/pinia';
import type { ShellTab } from '@/shell/types';
import DebugTab from './DebugTab.vue';
import NavSettingsTab from './NavSettingsTab.vue';

export function createDebugTab(): ShellTab {
    return {
        id: 'debug',
        tabTitle: '调试',
        mount(container) {
            const app = createApp(DebugTab);
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
