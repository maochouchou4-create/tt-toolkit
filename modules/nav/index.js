// modules/nav/index.js —— 消息回顶/上下文导航模块。
// 移植自酒馆助手全局脚本 v4（D:\code\消息回顶上下文-v4.js，只读参考）：
// 楼层定位主线/兜底、落点校验循环、自动回顶状态机、CONFIG 常量原样照搬，
// 本文件只重写接线层——
//   - 事件总线直连宿主 events.js（酒馆助手桥接与其兜底表删除：TT 无消息内
//     iframe 渲染结束事件，照搬旧订阅等于 on(undefined) 死代码）；
//   - 楼层数据取 getContext().chat 全量数组（绝对索引即楼层号）；角色判定
//     按 ChatPayload.md §4 语义：role 不总存在，缺失时回退 legacy 布尔
//     （openai.js:2236 是转换路径，不是存储形状——批3 回归根因）；
//   - 斜杠执行器走宿主 ABI（st-context.js:177），v4 的兜底转正为唯一路径；
//   - 日志转发接入 shared/log.js（v4 的 ttlog 转发器本体已抽成该工厂），
//     target 仍为 "msgnav"，落盘 tauritavern.log.*；
//   - 按钮为原生图标形态注入 #leftSendForm 图标槽（酒馆助手按钮 API 不可
//     移植，见 §8；用户拍板：不自造横条）。
// DOM 契约与 v4 同源已核：#chat / .mes[mesid]（index.html:8382 区域）、
// #mes_stop（:8417）、#send_but（:8422）、#leftSendForm 原生图标槽
// （#options_button fa-bars 同款 rail，index.html:8380-8426）。

import { eventSource, event_types } from "../../../../../../scripts/events.js";
import { createTtlog } from "../../shared/log.js";

// 防异常双注入：同 URL 的动态 import 不会重复执行，但扩展重载/缓存击穿
// 场景下 ESM 层无保护，仍需窗口旗标。字面量只出现一次（机判断言），
// 经由常量间接引用。
const NAV_FLAG = "__TT_NAV_MOD__";

// --------------------------------------------------------
// 1. CONFIG —— 所有可调参数集中在这里（与 v4 同值）
// --------------------------------------------------------
const CONFIG = Object.freeze({
    // 楼层定位一律优先走主线 /chat-jump（感知虚拟列表）；false 强制用脚本内滚动
    MAINLINE_JUMP_FIRST: true,
    // 脚本内兜底滚动：楼层顶部与容器顶的对齐偏移（负数 = 略微露出上一楼边缘）
    SCROLL_OFFSET_PX: -8,
    // 兜底滚动：判定"视口顶部楼层"的阈值（px）
    VISIBLE_THRESHOLD_PX: 8,
    // 自动回顶：生成结束(#mes_stop 消失)后的静默等待窗口；
    // 窗口内若出现 MESSAGE_UPDATED / 重渲染（MVU 改写正文等）则重新计时
    SETTLE_MS: 600,
    // 静默窗口最长累计时间，防止持续渲染导致永远不回顶
    MAX_SETTLE_MS: 5000,
    // 兜底滚动：虚拟化物化等待（把滚动推到底部后等楼层挂载，ms）
    MATERIALIZE_WAIT_MS: 120,
    // 上一条/下一条的记忆参考容差：视口顶距上次导航目标不超过该楼层数时，
    // 仍视为"正在看上次跳到的楼层"，从记忆点续跳（/chat-jump 居中落点会
    // 让视口顶偏离目标楼层，纯视口判定会跳乱）
    NAV_REF_TOLERANCE: 2,
    // 兜底滚动：落点校验轮数 / 首验等待 / 后续等待 / 容差（px）
    SCROLL_VERIFY_TRIES: 3,
    SCROLL_VERIFY_FIRST_DELAY_MS: 500,
    SCROLL_VERIFY_DELAY_MS: 150,
    SCROLL_VERIFY_TOLERANCE_PX: 2,
    // 自动回顶开关的持久化键（与 v4 iframe 时代同 key 同语义，升级无缝）
    STORAGE_KEY: "tt_msg_nav_auto_top",
    // 默认开启自动回顶
    AUTO_TOP_DEFAULT: true,
    // DOM 契约（TauriTavern 主干）
    SEL: Object.freeze({
        SCROLL_ROOT: "#chat",          // 滚动容器（chatSurface 的 root）
        MESSAGE: ".mes[mesid]",        // 楼层节点
        STOP_BUTTON: "#mes_stop",      // 生成期间显示的"暂停"按钮
        SEND_BUTTON: "#send_but",      // 空闲时的"发送"按钮
    }),
});

// --------------------------------------------------------
// 2. 日志与提示 —— 转发器本体在 shared/log.js（环形缓冲 + 批量防抖直调
//    宿主日志命令）；nav 只接线。熔断降级只丢持久日志，不影响功能。
// --------------------------------------------------------
const ttlog = createTtlog("msgnav");

// dump 排障口的数据序列化（与转发器同规则：Error 给栈、异常对象不炸）
function safeDumpText(value) {
    if (value === null || value === undefined) return "";
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

// shared/log.js 不暴露熔断态，dump 以宿主 invoke ABI 可用性作同阶诊断
function ttlogHealth() {
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURITAVERN__?.core?.invoke;
    return typeof invoke === "function" ? "ok" : "unavailable";
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 主窗口内 toastr 为全局；不可用时退回日志，不静默丢失用户反馈
function toast(message, level = "info") {
    try {
        const t = (typeof toastr !== "undefined" && toastr) || null;
        const fn = t?.[level] || t?.info;
        if (fn) fn.call(t, message);
        else ttlog.info(`toast-fallback ${level}: ${message}`);
    } catch {
        ttlog.info(`toast-fallback ${level}: ${message}`);
    }
}

// --------------------------------------------------------
// 3. DOM 定位 —— 主窗口本体运行，无跨窗口，直接 document
// --------------------------------------------------------
function getScrollRoot() {
    return document.querySelector(CONFIG.SEL.SCROLL_ROOT);
}

function findMessageEl(messageId) {
    return document.querySelector(`${CONFIG.SEL.MESSAGE}[mesid="${messageId}"]`);
}

// --------------------------------------------------------
// 4. 数据接口 —— 楼层号即 chat[] 绝对索引（全量数组，无窗口化，
//    ChatPayload 契约已核），不猜 DOM
// --------------------------------------------------------
function getChat() {
    try {
        return SillyTavern.getContext()?.chat ?? [];
    } catch (e) {
        ttlog.warn("getContext().chat unavailable", e?.message || String(e));
        return [];
    }
}

// 消息角色判定（ChatPayload.md §4）：正常楼层只保证 legacy 布尔
// is_user/is_system；role 并不总存在（Tool 明确 role:"tool" 且
// is_system:true）。role 缺失时按布尔回退：非用户、非系统＝Assistant。
// 只用 role==="assistant" 会在普通聊天里匹配 0 条（批3 实测回归根因）。
function messageRole(m) {
    if (typeof m?.role === "string" && m.role) return m.role;
    if (m?.is_user) return "user";
    if (m?.is_system) return "system";
    return "assistant";
}

function getAssistantFloorIds() {
    return getChat()
        .map((m, i) => (messageRole(m) === "assistant" ? i : Number.NaN))
        .filter(Number.isFinite);
}

function getLastMessageIdSafe() {
    const chat = getChat();
    return chat.length > 0 ? chat.length - 1 : null;
}

// 视口顶部当前正看到的楼层（只在已挂载的楼层里找 —— 可见的必然已挂载）
function getCurrentVisibleMessageId() {
    const root = getScrollRoot();
    if (!root) return null;
    const rootTop = root.getBoundingClientRect().top;
    for (const el of root.querySelectorAll(CONFIG.SEL.MESSAGE)) {
        const bottom = el.getBoundingClientRect().bottom;
        if (bottom < rootTop + CONFIG.VISIBLE_THRESHOLD_PX) continue; // 整体在视口顶之上
        const id = Number(el.getAttribute("mesid"));
        return Number.isFinite(id) ? id : null; // DOM 顺序即楼层升序，第一个跨过视口顶的就是它
    }
    return null;
}

// --------------------------------------------------------
// 5. 楼层定位核心 —— 主线 /chat-jump 优先，脚本内滚动仅作兜底
// --------------------------------------------------------
// 宿主 ABI 为唯一执行器来源（st-context.js:177）；无函数即走兜底滚动
function getSlashExecutor() {
    try {
        const exec = SillyTavern.getContext()?.executeSlashCommandsWithOptions;
        if (typeof exec === "function") return exec;
    } catch { /* 宿主上下文不可用，落兜底路径 */ }
    return null;
}

// 主线跳转：/chat-jump → virtual.force + 同步物化 + scrollToIndex（居中 + 高亮闪烁）
// 返回 { ok, mode: 'mainline' | 'fallback' } 供日志标注跳转方式
async function jumpToFloor(messageId) {
    if (!Number.isFinite(messageId)) {
        ttlog.warn(`jumpToFloor: invalid floor ${messageId}`);
        return { ok: false, mode: "fallback" };
    }
    if (CONFIG.MAINLINE_JUMP_FIRST) {
        const exec = getSlashExecutor();
        if (exec) {
            try {
                await exec(`/chat-jump ${messageId}`);
                ttlog.action(`jump -> #${messageId} (mainline)`);
                return { ok: true, mode: "mainline" };
            } catch (e) {
                ttlog.warn(`chat-jump -> #${messageId} failed, fallback scroll`, e?.message || String(e));
            }
        } else {
            ttlog.info("slash executor unavailable, fallback scroll");
        }
    }
    const ok = await scrollToMessageTop(messageId, { smooth: false });
    return { ok, mode: "fallback" };
}

// 兜底：脚本内"瞬时跳 + 落点校验"（目标未挂载先物化；落地后复核，偏差即修正）
async function scrollToMessageTop(messageId, { smooth = true } = {}) {
    if (!Number.isFinite(messageId)) {
        ttlog.warn(`scrollToMessageTop: invalid floor ${messageId}`);
        return false;
    }
    const root = getScrollRoot();
    if (!root) {
        ttlog.error(`scroll root ${CONFIG.SEL.SCROLL_ROOT} not found`);
        return false;
    }

    const materialize = async () => {
        let el = findMessageEl(messageId);
        if (!el) {
            ttlog.info(`floor #${messageId} not mounted, materialize tail`);
            try {
                root.scrollTop = root.scrollHeight;
                await sleep(CONFIG.MATERIALIZE_WAIT_MS);
                el = findMessageEl(messageId);
            } catch (e) {
                ttlog.error("materialize scroll failed", e?.message || String(e));
            }
        }
        return el;
    };

    let el = await materialize();
    if (!el) {
        ttlog.warn(`floor #${messageId} not mounted, abort scroll`);
        return false;
    }

    try {
        const rootRect = root.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const target = Math.max(0, root.scrollTop + (elRect.top - rootRect.top) + CONFIG.SCROLL_OFFSET_PX);
        ttlog.action(`scroll -> #${messageId} (fallback)`, { from: Math.round(root.scrollTop), to: Math.round(target) });
        root.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });

        // 落点校验：虚拟列表滚动途中重挂载/重测量楼层，内容可能整体位移把落点带偏
        for (let attempt = 1; attempt <= CONFIG.SCROLL_VERIFY_TRIES; attempt++) {
            await sleep(attempt === 1 ? CONFIG.SCROLL_VERIFY_FIRST_DELAY_MS : CONFIG.SCROLL_VERIFY_DELAY_MS);
            let verifyEl = findMessageEl(messageId);
            if (!verifyEl) {
                root.scrollTop = root.scrollHeight;
                await sleep(CONFIG.MATERIALIZE_WAIT_MS);
                verifyEl = findMessageEl(messageId);
                if (!verifyEl) break;
            }
            const delta = verifyEl.getBoundingClientRect().top - root.getBoundingClientRect().top + CONFIG.SCROLL_OFFSET_PX;
            if (Math.abs(delta) <= CONFIG.SCROLL_VERIFY_TOLERANCE_PX) {
                if (attempt > 1) ttlog.action(`landing corrected -> #${messageId}`);
                return true;
            }
            ttlog.info(`landing correction #${attempt} -> #${messageId} delta=${Math.round(delta)}px`);
            root.scrollTo({ top: Math.max(0, root.scrollTop + delta), behavior: "auto" });
        }
        ttlog.warn(`landing unstable after ${CONFIG.SCROLL_VERIFY_TRIES} tries -> #${messageId}`);
        return true;
    } catch (e) {
        ttlog.error(`scroll -> #${messageId} failed`, e?.message || String(e));
        return false;
    }
}

// --------------------------------------------------------
// 6. 手动功能 —— 回顶 / 上一条 / 下一条角色回复
//    导航参考楼层：/chat-jump 是居中落点，跳完视口顶不再是目标楼层，
//    若每次都按视口顶算会跳乱/漏楼。记住上次导航目标；用户明显滚开
//    （视口顶远离记忆点）则按视口顶算。CHAT_CHANGED 时清空。
// --------------------------------------------------------
let lastNavTarget = null;

function navReferenceId(currentId) {
    if (lastNavTarget !== null && Math.abs(currentId - lastNavTarget) <= NAV_REF_TOLERANCE) {
        return lastNavTarget;
    }
    return currentId;
}

async function scrollCurrentMessageToTop() {
    const currentId = getCurrentVisibleMessageId();
    const targetId = currentId ?? getLastMessageIdSafe();
    if (targetId === null) {
        ttlog.warn("top: no floor found (viewport empty, chat empty)");
        toast("未找到当前消息", "error");
        return;
    }
    const res = await jumpToFloor(targetId);
    if (!res.ok) ttlog.warn(`top failed -> #${targetId}`);
    else lastNavTarget = targetId;
    toast(res.ok ? `已定位楼层 #${targetId}` : "定位失败", res.ok ? "success" : "error");
}

async function navigateAssistantReply(direction) {
    const currentId = getCurrentVisibleMessageId();
    if (currentId === null) {
        ttlog.warn("nav: viewport floor not found");
        toast("未找到当前消息", "error");
        return;
    }
    const ids = getAssistantFloorIds();
    if (ids.length === 0) {
        // 失败必须留痕（批3 回归教训：toast 完就 return，日志零痕迹无法排障）
        ttlog.warn(`nav: no assistant floor found`, { chatLen: getChat().length, fromId: currentId });
        toast("没找到角色回复", "warning");
        return;
    }
    const refId = navReferenceId(currentId);

    let target = null;
    if (direction < 0) {
        for (let i = ids.length - 1; i >= 0; i--) {
            if (ids[i] < refId) { target = ids[i]; break; }
        }
        if (target === null) {
            ttlog.nav(`nav prev at first (ref #${refId}, ${ids.length} replies)`);
            toast("已经是第一条角色回复", "info");
            return;
        }
    } else {
        for (const id of ids) {
            if (id > refId) { target = id; break; }
        }
        if (target === null) {
            ttlog.nav(`nav next at last (ref #${refId}, ${ids.length} replies)`);
            toast("已经是最后一条角色回复", "info");
            return;
        }
    }

    const res = await jumpToFloor(target);
    if (res.ok) {
        lastNavTarget = target;
        toast(`${direction < 0 ? "已跳到上一条" : "已跳到下一条"}角色回复：#${target}`, "success");
        ttlog.nav(`${direction < 0 ? "prev" : "next"} #${refId} -> #${target} (${res.mode})`);
    } else {
        ttlog.warn(`nav ${direction < 0 ? "prev" : "next"} -> #${target} failed`);
        toast("定位失败", "error");
    }
}

// --------------------------------------------------------
// 7. 自动回顶 —— 主触发：#mes_stop 可见→隐藏（整条生成管线空闲）
//    加固：静默窗口内 MESSAGE_UPDATED / 楼层重渲染会顺延计时
// --------------------------------------------------------
const autoTop = {
    enabled: null,        // init 时填充
    settleTimer: null,    // setTimeout 句柄
    settleFirstAt: 0,     // 本轮静默窗口的起点（用于 MAX_SETTLE_MS 兜底）
    lastGenerationActive: null,
    observer: null,
};

function loadAutoTopEnabled() {
    try {
        const v = localStorage.getItem(CONFIG.STORAGE_KEY);
        if (v === "0") return false;
        if (v === "1") return true;
    } catch { /* 存储不可用时落到默认值，仅影响持久化 */ }
    return CONFIG.AUTO_TOP_DEFAULT;
}

function saveAutoTopEnabled(enabled) {
    try {
        localStorage.setItem(CONFIG.STORAGE_KEY, enabled ? "1" : "0");
    } catch { /* 忽略：仅影响持久化 */ }
}

// 生成是否进行中：主干用 $('#mes_stop').css('display') 切换（script.js:4448-4454）
function isGenerationActive() {
    const stop = document.querySelector(CONFIG.SEL.STOP_BUTTON);
    if (!stop) return false;
    if (stop.style.display === "none") return false;
    if (stop.classList.contains("displayNone")) return false;
    const display = stop.style.display || window.getComputedStyle(stop).display;
    return display !== "none" && display !== "";
}

function clearSettleTimer() {
    if (autoTop.settleTimer !== null) {
        clearTimeout(autoTop.settleTimer);
        autoTop.settleTimer = null;
    }
}

function scheduleAutoTop() {
    const now = Date.now();
    if (autoTop.settleTimer === null) autoTop.settleFirstAt = now;
    clearSettleTimer();
    if (now - autoTop.settleFirstAt >= CONFIG.MAX_SETTLE_MS) {
        ttlog.action("settle max wait reached, auto-top now");
        runAutoTop();
        return;
    }
    autoTop.settleTimer = setTimeout(() => {
        autoTop.settleTimer = null;
        runAutoTop();
    }, CONFIG.SETTLE_MS);
}

// 生成结束后仍有渲染活动（MVU 改写/楼层重渲染）时顺延静默窗口
function bumpSettle() {
    if (autoTop.settleTimer !== null) {
        scheduleAutoTop();
    }
}

async function runAutoTop() {
    try {
        if (!autoTop.enabled) {
            return;
        }
        const targetId = getLastMessageIdSafe();
        if (targetId === null) {
            ttlog.warn("auto-top: no floor to jump");
            return;
        }
        const res = await jumpToFloor(targetId);
        if (res.ok) {
            ttlog.action(`auto-top -> #${targetId} (${res.mode})`);
        } else {
            ttlog.warn("auto-top failed");
        }
    } catch (e) {
        ttlog.error("auto-top error", e?.message || String(e));
    }
}

function checkGenerationIdle() {
    const active = isGenerationActive();
    const wasActive = autoTop.lastGenerationActive;
    autoTop.lastGenerationActive = active;
    if (wasActive && !active) {
        if (autoTop.enabled) scheduleAutoTop();
    }
}

function startGenerationWatch() {
    const Obs = window.MutationObserver;
    const stop = document.querySelector(CONFIG.SEL.STOP_BUTTON);
    const send = document.querySelector(CONFIG.SEL.SEND_BUTTON);
    if (!Obs || (!stop && !send)) {
        ttlog.warn("generation watch unavailable", { observer: !!Obs, stop: !!stop, send: !!send });
        return;
    }
    autoTop.lastGenerationActive = isGenerationActive();
    autoTop.observer = new Obs(() => {
        try { checkGenerationIdle(); } catch (e) { ttlog.error("generation check error", e?.message || String(e)); }
    });
    const options = { attributes: true, attributeFilter: ["style", "class"] };
    if (stop) autoTop.observer.observe(stop, options);
    if (send) autoTop.observer.observe(send, options);
    ttlog.info("generation watch started", { stop: !!stop, send: !!send });
}

function toggleAutoTop() {
    autoTop.enabled = !autoTop.enabled;
    saveAutoTopEnabled(autoTop.enabled);
    refreshAutoButton();
    toast(`自动回顶已${autoTop.enabled ? "开启" : "关闭"}`, autoTop.enabled ? "success" : "info");
    ttlog.info(`auto-top toggled ${autoTop.enabled ? "on" : "off"}`);
}

// --------------------------------------------------------
// 8. 按钮 —— 注入输入框左侧原生图标槽 #leftSendForm（"≡"选项按钮
//    同款 rail、同款 interactable 图标形态，用户拍板：不自造横条）。
//    四个图标按钮：定位（回顶）/上一条/下一条/自动回顶开关。
//    自动回顶用图标透明度区分开/关，title 常显状态。
// --------------------------------------------------------
const NAV_BAR_ID = "tt-nav-icons";
const NAV_AUTO_BTN_ID = "tt-nav-auto-btn";

let autoTopButton = null;

// 同步/异步 handler 的异常都归到日志，不静默吞进 unhandledrejection
function buildNavIcon(id, iconClass, title, onClick) {
    const btn = document.createElement("div");
    btn.id = id;
    btn.className = `fa-solid ${iconClass} interactable tt-nav-icon`;
    btn.title = title;
    btn.tabIndex = 0;
    btn.addEventListener("click", () => {
        Promise.resolve(onClick()).catch(e => ttlog.error("nav button handler error", e?.message || String(e)));
    });
    return btn;
}

function mountButtonBar() {
    if (document.getElementById(NAV_BAR_ID)) return; // 防重复注入
    const rail = document.getElementById("leftSendForm");
    if (!rail) {
        ttlog.warn("nav icons mount failed: #leftSendForm not found");
        return;
    }
    const wrap = document.createElement("div");
    wrap.id = NAV_BAR_ID;
    wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;";
    wrap.append(
        buildNavIcon("tt-nav-top", "fa-location-arrow", "当前消息回顶：视口顶楼层对齐", () => scrollCurrentMessageToTop()),
        buildNavIcon("tt-nav-prev", "fa-chevron-up", "上一条角色回复", () => navigateAssistantReply(-1)),
        buildNavIcon("tt-nav-next", "fa-chevron-down", "下一条角色回复", () => navigateAssistantReply(1)),
    );
    autoTopButton = buildNavIcon(NAV_AUTO_BTN_ID, "fa-bolt", "自动回顶：生成结束后跳回最新楼层（点击开关）", () => toggleAutoTop());
    wrap.append(autoTopButton);
    rail.append(wrap);
    refreshAutoButton();
}

// 开关状态用透明度+提示语表达（不换图标，避免误触后状态不可读）
function refreshAutoButton() {
    if (autoTopButton) {
        autoTopButton.style.opacity = autoTop.enabled ? "1" : "0.35";
        autoTopButton.title = `自动回顶：${autoTop.enabled ? "开" : "关"}（点击切换）`;
    }
}

// --------------------------------------------------------
// 9. 事件与排障口
// --------------------------------------------------------
function bindEvents() {
    // 渲染活动顺延静默窗口（MVU 改写正文、楼层重渲染）
    eventSource.on(event_types.MESSAGE_UPDATED, () => bumpSettle());
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => bumpSettle());

    // 切换聊天时丢弃未完成的自动回顶与楼层记忆点（新聊天楼号重排）
    eventSource.on(event_types.CHAT_CHANGED, () => {
        clearSettleTimer();
        lastNavTarget = null;
        ttlog.info("chat changed, pending auto-top dropped, nav ref cleared");
    });
}

// 无 UI 排障口：主窗口 devtools 直取 __TT_NAV__.dump()
function dump() {
    const root = getScrollRoot();
    const lines = [
        `tt-toolkit nav dump @ ${new Date().toISOString()}`,
        `version=nav-v1 autoTop=${autoTop.enabled ? "on" : "off"} ttlog=${ttlogHealth()} mode=${getSlashExecutor() ? "mainline" : "fallback"}`,
        `root=${root ? `#${root.id || "(no id)"}` : "missing"}` +
            ` mounted=${root ? root.querySelectorAll(CONFIG.SEL.MESSAGE).length : 0}` +
            ` lastId=${getLastMessageIdSafe()} genActive=${isGenerationActive()}`,
        "--- ring (oldest first) ---",
        ...ttlog.getBuffer().map(e => `${e.timestamp} [${e.type}] ${e.message}${e.data !== null && e.data !== undefined ? ` | ${safeDumpText(e.data)}` : ""}`),
    ];
    return lines.join("\n");
}

// --------------------------------------------------------
// 10. 初始化（加载完成不加 toast：loader 的 tt-toolkit[nav] ready 日志即载体）
// --------------------------------------------------------
function initNav() {
    window.__TT_NAV__ = Object.freeze({ version: "nav-v1", dump });

    autoTop.enabled = loadAutoTopEnabled();
    mountButtonBar();
    bindEvents();
    startGenerationWatch();

    ttlog.info(`nav-v1 loaded autoTop=${autoTop.enabled ? "on" : "off"} mode=${CONFIG.MAINLINE_JUMP_FIRST ? "mainline" : "fallback"} ttlog=${ttlogHealth()}`);
}

function onReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
}

if (window[NAV_FLAG]) {
    console.warn("[tt-toolkit][nav] already loaded, skip re-injection");
} else {
    window[NAV_FLAG] = true;
    onReady(initNav);
}
