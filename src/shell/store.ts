/**
 * 壳状态（Pinia）：浮层开合、tab 注册表、激活 tab。
 * tab 描述符含函数体（非序列化内存态），不入持久化。
 */
import { defineStore } from 'pinia';
import type { ShellTab } from './types';

interface ShellState {
    open: boolean;
    tabs: ShellTab[];
    activeTabId: string | null;
}

export const useShellStore = defineStore('tt-shell', {
    state: (): ShellState => ({
        open: false,
        tabs: [],
        activeTabId: null,
    }),
    getters: {
        activeTab(state): ShellTab | null {
            return state.tabs.find(t => t.id === state.activeTabId) ?? null;
        },
    },
    actions: {
        registerTab(tab: ShellTab) {
            if (this.tabs.some(t => t.id === tab.id)) {
                console.warn(`[tt-toolkit][shell] tab "${tab.id}" 已注册，跳过`);
                return;
            }
            this.tabs.push(tab);
            // 首个 tab 注册即成为默认激活目标；内容延迟到浮层首次打开才挂载
            if (this.activeTabId === null) this.activeTabId = tab.id;
        },
        activate(tabId: string) {
            if (!this.tabs.some(t => t.id === tabId)) return;
            this.activeTabId = tabId;
        },
        toggle(open?: boolean) {
            this.open = open ?? !this.open;
        },
    },
});
