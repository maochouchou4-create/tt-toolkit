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
