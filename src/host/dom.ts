/**
 * TT 宿主 DOM 适配：魔棒菜单注入、浮层拖动、宿主 jQuery 桥。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - **#extensionsMenu 魔棒菜单**：`scripts/extensions.js:919-954`
 *   addExtensionsButtonAndMenu() 用 wandMenu 模板挂出
 *   `#extensionsMenu`（document.body 下）+ 输入框左侧
 *   `#extensionsMenuButton`；注入先例＝caption 扩展（scripts/extensions/
 *   caption/index.js:469-476）：向 `#extensionsMenu` append
 *   `.list-group-item.flex-container.flexGap5` 容器（内含
 *   `.extensionsMenuExtensionButton` 图标 div + 文本 span），点击即触发。
 *   `#extensionsMenu` 的创建晚于扩展脚本加载（ensureExtensionsUiReady
 *   异步执行），注入入口必须等待其出现。
 * - **dragElement 拖动**：`scripts/RossAscends-mods.js:498` 导出
 *   `dragElement($elmnt)`——参数为 jQuery 包装对象；要求目标元素有 id，
 *   拖把手 selector 固定为 `#<id>header`（:506-508）；内部会把位置写入
 *   power_user.movingUIState 并调 saveSettingsDebounced（:511-524），
 *   需要宿主 jQuery（全局 $）在场。
 * - **drawer-content 浮层先例**：index.html:8038 `#floatingPrompt`
 *   （class="drawer-content flexGap5"，置于 `#movingDivs` 容器内），
 *   标题栏为 `.panelControlBar`，内含 `<div id="floatingPromptheader"
 *   class="fa-fw fa-solid fa-grip drag-grabber">`。style.css:5857-5882
 *   `.drawer-content` 提供 SmartTheme 变量配色（--SmartThemeBlurTintColor
 *   背景 / --SmartThemeBodyColor 文字 / --SmartThemeBorderColor 边框）
 *   与 openDrawer 显示态；:5884 `#movingDivs>.drawer-content { height:
 *   unset; }`、:5918 `#floatingPrompt` 为 position:fixed + 最小 100px。
 */

/** 宿主注入的运行时全局（lib.js / jQuery 等 index.html 顺序加载）。 */
interface HostWindow {
    $?: ((selector: string) => { dragElement?: (el: unknown) => void }) & ((selector: string) => unknown);
    SillyTavern?: { getContext?: () => unknown };
    quickReplyApi?: unknown;
    toastr?: Record<string, (message: string, title?: string) => void>;
    __TAURI__?: { core?: { invoke?: unknown } };
    __TAURITAVERN__?: { core?: { invoke?: unknown } };
}

export const hostWindow = globalThis as unknown as HostWindow;

/**
 * 调 dragElement 给浮层接宿主拖动。把手必须已存在于 DOM
 * （id 约定 `<浮层id>header`）。jQuery 或 dragElement 缺席时返回 false，
 * 调用方降级为不可拖浮层——拖动是壳的增强能力而非生存条件。
 */
export function attachHostDrag(elementId: string): boolean {
    const jq = hostWindow.$;
    if (typeof jq !== 'function') return false;
    const wrapped = (jq as (selector: string) => { dragElement?: (el: unknown) => void })(`#${elementId}`);
    if (typeof wrapped?.dragElement !== 'function') return false;
    try {
        // dragElement 自身会解析把手 `#<id>header`，传入主元素包装即可
        wrapped.dragElement(wrapped);
        return true;
    } catch (e) {
        console.error(`[tt-toolkit][host] dragElement(${elementId}) 失败`, e);
        return false;
    }
}

export interface WandMenuEntry {
    icon: string;
    label: string;
    title: string;
    onClick: () => void;
}

/**
 * 向 #extensionsMenu 注入一个魔棒入口（caption 先例结构）。
 * 菜单尚未创建（扩展加载先于 wandMenu 挂载）时返回 false，调用方按
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
