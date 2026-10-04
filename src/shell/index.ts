/**
 * 壳挂载与对外 API：drawer-content 浮层（Vue app 渲染）＋魔棒菜单入口。
 *
 * 挂载结构：
 *   - #movingDivs 下建 <div id="tt-shell-mount">，Vue app 渲染浮层本体
 *     （#movingDivs 是宿主 movable 面板容器，#floatingPrompt 同款待遇，
 *     host/dom.ts 核实记录）；
 *   - #extensionsMenu 注入魔棒入口（裸 div，官方样式选择器覆盖，
 *     host/dom.ts 核实记录）；菜单理论先于扩展脚本在场
 *     （extensions.js:406-418 uiReady 先于 :2069 activateExtensions），
 *     「立查 → APP_READY → 轮询」三段等待是纵深防御而非必要条件。
 */

import { createApp } from 'vue';
import { appendWandMenuEntry, eventBus, event_types } from '@/host';
import { pinia } from '@/pinia';
import { version } from '@/version';
import ShellApp from './ShellApp.vue';
import { useShellStore } from './store';
import type { ShellTab } from './types';

const MOUNT_ID = 'tt-shell-mount';
const WAND_ENTRY_ID = 'tt-toolkit-wand-entry';

// 魔棒入口等待参数：#extensionsMenu 理论先于扩展脚本在场（host/dom.ts
// 头注核实），三段等待为纵深防御——轮询仍按最坏情况放宽
const WAND_POLL_INTERVAL_MS = 250;
const WAND_POLL_MAX_TRIES = 40;

let shellMounted = false;

/** 注册功能页（模块侧入口）：id 重复时拒绝并警告。 */
export function registerTab(tab: ShellTab): void {
    useShellStore().registerTab(tab);
}

/** 开/关/翻转壳浮层。 */
export function toggleShell(open?: boolean): void {
    useShellStore().toggle(open);
}

function installWandEntry(): void {
    if (shellMounted) return;
    shellMounted = true;
    const mount = document.createElement('div');
    mount.id = MOUNT_ID;
    const movingDivs = document.querySelector('#movingDivs');
    if (movingDivs) movingDivs.appendChild(mount);
    else document.body.appendChild(mount);
    const app = createApp(ShellApp);
    app.use(pinia);
    app.mount(mount);

    tryWandEntry();
}

function tryWandEntry(): void {
    const ok = appendWandMenuEntry(
        {
            icon: 'fa-toolbox',
            label: 'TT 工具箱',
            title: '打开 TT 工具箱面板',
            onClick: () => toggleShell(),
        },
        WAND_ENTRY_ID,
    );
    if (ok) return;

    // 三段等待的第二段：APP_READY 晚订阅会立即重放（EventEmitter 语义）
    eventBus.once(event_types.APP_READY, tryWandEntry);
    // 第三段：轮询兜底（APP_READY 已发而菜单仍缺席＝宿主未建菜单的情形）
    let tries = 0;
    const timer = setInterval(() => {
        const done = appendWandMenuEntry(
            {
                icon: 'fa-toolbox',
                label: 'TT 工具箱',
                title: '打开 TT 工具箱面板',
                onClick: () => toggleShell(),
            },
            WAND_ENTRY_ID,
        );
        tries++;
        if (done || tries >= WAND_POLL_MAX_TRIES) {
            clearInterval(timer);
            if (!done && tries >= WAND_POLL_MAX_TRIES) {
                console.warn(`[tt-toolkit][shell] #extensionsMenu 等待超时（${version}），魔棒入口未注入`);
            }
            return;
        }
    }, WAND_POLL_INTERVAL_MS);
}

/**
 * 挂载壳（main.ts 引导调用）。幂等：重复调用只挂一次。
 */
export function mountShell(): void {
    installWandEntry();
}
