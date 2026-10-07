/**
 * 壳的功能页注册（tab 描述符）。每 tab 一个 createApp + 共享 pinia
 * （tab 契约 mount(container) 的 Vue 实现形态，后续批次的功能页照此）。
 */

import { createApp } from 'vue';
import { pinia } from '@/pinia';
import type { ShellTab } from '@/shell/types';
import { useApisStore } from '@/modules/apis/store';
import { useSummaryStore } from '@/modules/summary/store';
import ApiTab from './ApiTab.vue';
import ChoiceSettingsTab from './ChoiceSettingsTab.vue';
import LogTab from './LogTab.vue';
import PersonaTab from './PersonaTab.vue';
import SummaryTab from './SummaryTab.vue';

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
    };
}

export function createSummaryTab(): ShellTab {
    return {
        id: 'summary',
        tabTitle: '总结',
        mount(container) {
            const app = createApp(SummaryTab);
            app.use(pinia);
            app.mount(container);
        },
        // tab 常驻挂载（容器只挂一次、激活只切可见）——后台自动总结落账后，
        // 状态行靠这里每次激活刷新（resync 三触发点之一）
        onActivate() {
            useSummaryStore(pinia).resync();
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
