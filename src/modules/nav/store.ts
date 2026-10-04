/**
 * nav 模块状态（Pinia）：自动回顶开关。
 * 单一事实源＝storage 全局域（迁移自旧 localStorage 键）；store 不落
 * 值快照（快照＝第二真相源，命令通道写入后 UI 侧会失同步）——
 * getters 读透传 getNavState()，写入经 setAutoTop 写穿。
 * 响应式失效信号：storage 域是宿主的非响应式对象，getter 无法自动
 * 追踪其变更，setAutoTop 内 bump revision 触发 getter 重算——本开关
 * 的全部写方（/ttnav-auto 命令与设置 tab）都走该 action，覆盖完整。
 */
import { defineStore } from 'pinia';
import { getNavState, setNavState } from '@/storage';

export const useNavStore = defineStore('tt-nav', {
    state: () => ({
        /** 写穿计数：每次 setAutoTop 递增，作为读透传 getter 的失效信号 */
        revision: 0,
    }),
    getters: {
        autoTop(state): boolean {
            void state.revision;
            return getNavState().autoTop;
        },
    },
    actions: {
        setAutoTop(value: boolean) {
            setNavState({ autoTop: value });
            this.revision++;
        },
    },
});
