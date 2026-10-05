/**
 * TT 宿主 DOM 适配：魔棒菜单注入、浮层拖动、宿主 jQuery 桥。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - **#extensionsMenu 魔棒菜单**：`scripts/extensions.js:919-954`
 *   addExtensionsButtonAndMenu() 用 wandMenu/wandButton 模板挂出
 *   `#extensionsMenu`（document.body 下）+ 输入框左侧
 *   `#extensionsMenuButton`。注入先例有二：caption 扩展走**专用容器**
 *   （wandMenu.html:5 模板内建的 `#caption_wand_container`，
 *   caption/index.js:476 向其 append）；直接向 `#extensionsMenu`
 *   append 的裸 div 是官方支持的形态——style.css:1203/1218/1225 的
 *   选择器（`#extensionsMenu>div:not(.extension_container)` 的配色与
 *   hover 态）明确覆盖非容器子项。菜单先于扩展脚本在场：
 *   extensions.js:406-418 的 uiReady（ensureExtensionsUiReady）先于
 *   :2069 activateExtensions（第三方扩展脚本在此加载）——本层的
 *   三段等待是纵深防御，不是必要条件。
 * - **dragElement 拖动**：`scripts/RossAscends-mods.js:498` 导出
 *   `dragElement($elmnt)`——**ESM 导出函数，不是 jQuery 插件**（$.fn 上
 *   没有它；宿主自身用法＝import 后调用 `dragElement($('#id'))`，见
 *   initMovingUI :681-685）。参数为 jQuery 包装对象；要求目标元素有 id，
 *   拖把手 selector 固定为 `#<id>header` 且须带 .drag-grabber 类
 *   （:648-656 才绑 mousedown）；拖动中把位置写入
 *   power_user.movingUIState 并调 saveSettingsDebounced（:511-524）。
 *   拖动手势不受 movingUI 开关门控。**已知边界（宿主缺陷，非本层可修）**：
 *   movingUI 关闭（宿主默认，power-user.js:193）时 :537-547 的 movingUI
 *   检查拦截整个 observer 回调——drag 路径的 top/left 变量更新（:552-557）
 *   一并被跳过，而 closeDragElement 仍无条件保存，结果只持久化
 *   {margin:'unset'} 脏条目、位置丢失（宿主自家浮层同病）。要位置记忆
 *   须开宿主 Moving UI。位置成功持久化后，宿主自身的恢复流程先于扩展
 *   挂载、覆盖不到本扩展元素——壳挂载时读 movingUIState 自恢复
 *   （getSavedMovingUIState）。
 * - **drawer-content 浮层先例**：index.html:8038 `#floatingPrompt`
 *   （class="drawer-content flexGap5"，置于 `#movingDivs` 容器内），
 *   标题栏为 `.panelControlBar`，内含 `<div id="floatingPromptheader"
 *   class="fa-fw fa-solid fa-grip drag-grabber">`。style.css:5857-5882
 *   `.drawer-content` 提供 SmartTheme 变量配色（--SmartThemeBlurTintColor
 *   背景 / --SmartThemeBodyColor 文字 / --SmartThemeBorderColor 边框）
 *   与 openDrawer 显示态；:5884 `#movingDivs>.drawer-content { height:
 *   unset; }`、:5918 `#floatingPrompt` 为 position:fixed + 最小 100px。
 */

import { dragElement as stDragElement } from '@sillytavern/scripts/RossAscends-mods';
import { getTavernContext } from './context';

/** 宿主注入的运行时全局（lib.js / jQuery 等 index.html 顺序加载）。 */
interface HostWindow {
    $?: (selector: string) => unknown;
    SillyTavern?: { getContext?: () => unknown };
    quickReplyApi?: unknown;
    toastr?: Record<string, (message: string, title?: string) => void>;
    __TAURI__?: { core?: { invoke?: unknown } };
    __TAURITAVERN__?: { core?: { invoke?: unknown } };
}

export const hostWindow = globalThis as unknown as HostWindow;

/**
 * 调 dragElement 给浮层接宿主拖动（ESM 导入直调，非 jQuery 方法——
 * 在 $.fn 上找它永远找不到，曾经的实锤）。把手必须已存在于 DOM
 * （id 约定 `<浮层id>header` 且带 .drag-grabber 类）。jQuery 缺席时
 * 返回 false，调用方降级为不可拖浮层——拖动是壳的增强能力而非生存条件。
 */
export function attachHostDrag(elementId: string): boolean {
    const jq = hostWindow.$;
    if (typeof jq !== 'function') return false;
    const wrapped = jq(`#${elementId}`);
    try {
        stDragElement(wrapped);
        return true;
    } catch (e) {
        console.error(`[tt-toolkit][host] dragElement(${elementId}) 失败`, e);
        return false;
    }
}

/**
 * 宿主 movingUIState 里的单浮层持久化条目（dragElement 写入的形态）。
 * right/bottom 声明只为形态完整——恢复消费侧有意不取（同时设 top+bottom
 * 会把自适应高度元素拉伸变形，见 ShellApp 恢复处注释）。
 */
export interface MovingUIStateEntry {
    top?: number;
    left?: number;
    right?: number;
    bottom?: number;
    width?: number;
    height?: number;
    margin?: string;
}

/**
 * 读宿主持久化的浮层位置。宿主自身的恢复流程先于扩展挂载、覆盖不到
 * 本扩展的元素，浮层须在挂载时经此接口自恢复。
 */
export function getSavedMovingUIState(elementId: string): MovingUIStateEntry | null {
    const state = getTavernContext()?.powerUserSettings?.movingUIState;
    const entry = state?.[elementId];
    return entry !== null && typeof entry === 'object' ? (entry as MovingUIStateEntry) : null;
}

export interface WandMenuEntry {
    icon: string;
    label: string;
    title: string;
    onClick: () => void;
}

/**
 * 向 #extensionsMenu 注入一个魔棒入口（裸 div 形态，官方样式选择器
 * 覆盖，见文件头）。菜单理论先于扩展脚本在场，但此处仍防御性处理
 * 缺席（宿主加载流程变更时不至于崩）：返回 false，调用方按
 * APP_READY/轮询重试。静态模板无插值，innerHTML 注入无 XSS 面。
 */
export function appendWandMenuEntry(entry: WandMenuEntry, elementId: string): boolean {
    const menu = document.querySelector('#extensionsMenu');
    if (!menu) return false;
    if (document.getElementById(elementId)) return true;
    const item = document.createElement('div');
    item.id = elementId;
    item.className = 'list-group-item flex-container flexGap5';
    item.title = entry.title;
    item.innerHTML = `<div class="fa-solid ${entry.icon} extensionsMenuExtensionButton"></div><span>${entry.label}</span>`;
    item.addEventListener('click', () => entry.onClick());
    menu.appendChild(item);
    return true;
}
