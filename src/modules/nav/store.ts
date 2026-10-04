/**
 * nav 模块状态（Pinia）：自动回顶开关。
 * 单一事实源＝storage 全局域（迁移自旧 localStorage 键），store 是它
 * 的内存视图；命令（/ttnav-auto）与设置 tab 都经 setAutoTop 落盘。
 */
import { defineStore } from 'pinia';
import { getNavState, setNavState } from '@/storage';

export const useNavStore = defineStore('tt-nav', {
    state: () => ({
        autoTop: getNavState().autoTop,
    }),
    actions: {
        setAutoTop(value: boolean) {
            this.autoTop = value;
            setNavState({ autoTop: value });
        },
    },
});
