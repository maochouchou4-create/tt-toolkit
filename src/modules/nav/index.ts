/**
 * 消息回顶/上下文导航（方案 §2.6：逻辑平移，纯 TS 无 UI）。
 *
 * 平移自 modules/nav/index.js（v2，D:\code\repos\tt-toolkit\modules\nav\index.js）：
 * 楼层定位主线/兜底、落点校验循环、自动回顶状态机、CONFIG 常量原样照搬。
 * 平移层的接线差异：
 *   - @sillytavern 导入（events/SlashCommand）改走本仓 host 适配层
 *     （host 层已做重名注册 pre-check 与类型收敛）；
 *   - 楼层数据取 getContext().chat 全量数组（绝对索引即楼层号）；角色
 *     判定按 ChatPayload 契约：role 不总存在，缺失时回退 legacy 布尔
 *     （只判 role==='assistant' 在普通聊天匹配 0 条——批3 回归根因）；
 *   - 斜杠执行器走宿主 executeSlashCommandsWithOptions，缺席时脚本内
 *     滚动作兜底；
 *   - autoTop/qrActivated 持久化改走统一存储（storage.service 迁移旧
 *     localStorage 键，旧键保留只读、清理归批E）；
 *   - 日志转发走 host/ttlog（createTtlog 工厂），target 仍为 "msgnav"，
 *     落盘 tauritavern.log.*；
 *   - 入口仍为 TT 原生快速回复栏：「tt-toolkit 导航」按钮集（四导航键
 *     ＋末位「工具箱」键，消息体为 /ttnav-* 与 /tt-toolbox 斜令），
 *     命令亦可直接在输入框敲。
 * - 初始化为显式导出（initNav / initNavMinimal），由 main.ts 统一做
 *   环境分支后调用——模块求值期不自启动：storage 必须先初始化（旧
 *   localStorage 键迁移），否则 store 首读会拿到迁移前的旧值。
 * DOM 契约与 v2 同源已核：#chat / .mes[mesid]（TT index.html:8382 区域）、
 * #mes_stop（:8417）、#send_but（:8422）。
 */

import {
    createTtlog,
    eventBus,
    event_types,
    executeSlashCommand,
    getChatMessages,
    getTavernContext,
    hostWindow,
    isSlashCommandRegistered,
    registerSlashCommand,
    type ChatMessage,
    type Ttlog,
} from '@/host';
import { TOOLBOX_COMMAND } from '@/shell';
import { getNavState, setNavState } from '@/storage';
import { useNavStore } from './store';

// 防异常双注入：同 URL 的动态 import 不会重复执行，但扩展重载/缓存击穿
// 场景下 ESM 层无保护，仍需窗口旗标。字面量只出现一次（机判断言），
// 经由常量间接引用。
const NAV_FLAG = '__TT_NAV_MOD__';

// 版本戳：加载日志 / dump / 错误 toast 全带版本，现场排障可区分运行的
// 是哪一版（两版同名 nav-v1 时日志无法归因的教训）
const NAV_VERSION = 'nav-v3-rewrite';

// --------------------------------------------------------
// 1. CONFIG —— 所有可调参数集中在这里（与 v2 同值）
// --------------------------------------------------------
const CONFIG = Object.freeze({
    // 楼层定位一律优先走主线 /chat-jump（感知虚拟列表）；false 强制用脚本内滚动
    MAINLINE_JUMP_FIRST: true,
    // 脚本内兜底滚动：楼层顶部与容器顶的对齐偏移（负数 = 略微露出上一楼边缘）
    SCROLL_OFFSET_PX: -8,
    // 兜底滚动：判定“视口顶部楼层”的阈值（px）
    VISIBLE_THRESHOLD_PX: 8,
    // 自动回顶：生成结束(#mes_stop 消失)后的静默等待窗口；
    // 窗口内若出现 MESSAGE_UPDATED / 重渲染（MVU 改写正文等）则重新计时
    SETTLE_MS: 600,
    // 静默窗口最长累计时间，防止持续渲染导致永远不回顶
    MAX_SETTLE_MS: 5000,
    // 兜底滚动：虚拟化物化等待（把滚动推到底部后等楼层挂载，ms）
    MATERIALIZE_WAIT_MS: 120,
    // 上一条/下一条的记忆参考容差：视口顶距上次导航目标不超过该楼层数时，
    // 仍视为“正在看上次跳到的楼层”，从记忆点续跳（/chat-jump 居中落点会
    // 让视口顶偏离目标楼层，纯视口判定会跳乱）
    NAV_REF_TOLERANCE: 2,
    // 兜底滚动：落点校验轮数 / 首验等待 / 后续等待 / 容差（px）
    SCROLL_VERIFY_TRIES: 3,
    SCROLL_VERIFY_FIRST_DELAY_MS: 500,
    SCROLL_VERIFY_DELAY_MS: 150,
    SCROLL_VERIFY_TOLERANCE_PX: 2,
    // 旧 localStorage 键名：迁移源（storage.service 启动时搬入统一存储，
    // 旧键保留只读）。此处仅留档防键名漂移，不直接读写。
    LEGACY_STORAGE_KEY: 'tt_msg_nav_auto_top',
    LEGACY_QR_ACTIVATED_KEY: 'tt_nav_qr_activated',
    // DOM 契约（TauriTavern 主干）
    SEL: Object.freeze({
        SCROLL_ROOT: '#chat',          // 滚动容器（chatSurface 的 root）
        MESSAGE: '.mes[mesid]',        // 楼层节点
        STOP_BUTTON: '#mes_stop',      // 生成期间显示的“暂停”按钮
        SEND_BUTTON: '#send_but',      // 空闲时的“发送”按钮
    }),
});

// --------------------------------------------------------
// 2. 日志与提示 —— 转发器在 host/ttlog（环形缓冲 + 批量防抖直调宿主
//    日志命令）；nav 只接线。熔断降级只丢持久日志，不影响功能。
// --------------------------------------------------------
const ttlog: Ttlog = createTtlog('msgnav');

// dump 排障口的数据序列化（与转发器同规则：Error 给栈、异常对象不炸）
function safeDumpText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

// host/ttlog 不暴露熔断态，dump 以宿主 invoke ABI 可用性作同阶诊断
function ttlogHealth(): string {
    const invoke = (globalThis as { __TAURI__?: { core?: { invoke?: unknown } }; __TAURITAVERN__?: { core?: { invoke?: unknown } } })
        .__TAURI__?.core?.invoke
        ?? (globalThis as { __TAURITAVERN__?: { core?: { invoke?: unknown } } }).__TAURITAVERN__?.core?.invoke;
    return typeof invoke === 'function' ? 'ok' : 'unavailable';
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 主窗口内 toastr 为全局；不可用时退回日志，不静默丢失用户反馈
function toast(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    try {
        const t = hostWindow.toastr;
        const fn = t?.[level] ?? t?.info;
        if (fn) fn.call(t, message);
        else ttlog.info(`toast-fallback ${level}: ${message}`);
    } catch {
        ttlog.info(`toast-fallback ${level}: ${message}`);
    }
}

// --------------------------------------------------------
// 3. DOM 定位 —— 主窗口本体运行，无跨窗口，直接 document
// --------------------------------------------------------
function getScrollRoot(): HTMLElement | null {
    return document.querySelector(CONFIG.SEL.SCROLL_ROOT);
}

function findMessageEl(messageId: number): HTMLElement | null {
    return document.querySelector(`${CONFIG.SEL.MESSAGE}[mesid="${messageId}"]`);
}

// --------------------------------------------------------
// 4. 数据接口 —— 楼层号即 chat[] 绝对索引（全量数组，无窗口化），
//    不猜 DOM；统一走 host 层（getChatMessages）
// --------------------------------------------------------
function getChat(): ChatMessage[] {
    return getChatMessages();
}

// 消息角色判定（ChatPayload 契约）：正常楼层只保证 legacy 布尔
// is_user/is_system；role 并不总存在（Tool 明确 role:"tool" 且
// is_system:true）。role 缺失时按布尔回退：非用户、非系统＝Assistant。
function messageRole(m: ChatMessage): string {
    if (typeof m?.role === 'string' && m.role) return m.role;
    if (m?.is_user) return 'user';
    if (m?.is_system) return 'system';
    return 'assistant';
}

function getAssistantFloorIds(): number[] {
    return getChat()
        .map((m, i) => (messageRole(m) === 'assistant' ? i : Number.NaN))
        .filter(Number.isFinite);
}

function getLastMessageIdSafe(): number | null {
    const chat = getChat();
    return chat.length > 0 ? chat.length - 1 : null;
}

// 视口顶部当前正看到的楼层（只在已挂载的楼层里找 —— 可见的必然已挂载）
function getCurrentVisibleMessageId(): number | null {
    const root = getScrollRoot();
    if (!root) return null;
    const rootTop = root.getBoundingClientRect().top;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CONFIG.SEL.MESSAGE))) {
        const bottom = el.getBoundingClientRect().bottom;
        if (bottom < rootTop + CONFIG.VISIBLE_THRESHOLD_PX) continue; // 整体在视口顶之上
        const id = Number(el.getAttribute('mesid'));
        return Number.isFinite(id) ? id : null; // DOM 顺序即楼层升序，第一个跨过视口顶的就是它
    }
    return null;
}

// --------------------------------------------------------
// 5. 楼层定位核心 —— 主线 /chat-jump 优先，脚本内滚动仅作兜底
//    （执行器来源＝host 层 executeSlashCommand：宿主 ABI 为唯一路径）
// --------------------------------------------------------
// 跳转通道运行时真值（dump 排障面）：执行器在场探测 + 每次实际跳转
// 记录的通道。回显 CONFIG 常量只证明「配置想用主线」，证明不了
// 「执行器在场 / 实际走了主线」——排障时两者要能区分。
let lastJumpMode: 'mainline' | 'fallback' | null = null;

function jumpExecutorAvailable(): boolean {
    return typeof getTavernContext()?.executeSlashCommandsWithOptions === 'function';
}

// 主线跳转：/chat-jump → virtual.force + 同步物化 + scrollToIndex（居中 + 高亮闪烁）
// 返回 { ok, mode: 'mainline' | 'fallback' } 供日志标注跳转方式
async function jumpToFloor(messageId: number): Promise<{ ok: boolean; mode: 'mainline' | 'fallback' }> {
    if (!Number.isFinite(messageId)) {
        ttlog.warn(`jumpToFloor: invalid floor ${messageId}`);
        return { ok: false, mode: 'fallback' };
    }
    if (CONFIG.MAINLINE_JUMP_FIRST) {
        try {
            await executeSlashCommand(`/chat-jump ${messageId}`);
            lastJumpMode = 'mainline';
            ttlog.action(`jump -> #${messageId} (mainline)`);
            return { ok: true, mode: 'mainline' };
        } catch (e) {
            ttlog.warn(`chat-jump -> #${messageId} failed, fallback scroll`, e instanceof Error ? e.message : String(e));
        }
    }
    lastJumpMode = 'fallback';
    const ok = await scrollToMessageTop(messageId, { smooth: false });
    return { ok, mode: 'fallback' };
}

// 兜底：脚本内“瞬时跳 + 落点校验”（目标未挂载先物化；落地后复核，偏差即修正）
async function scrollToMessageTop(messageId: number, { smooth = true } = {}): Promise<boolean> {
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
                ttlog.error('materialize scroll failed', e instanceof Error ? e.message : String(e));
            }
        }
        return el;
    };

    const el = await materialize();
    if (!el) {
        ttlog.warn(`floor #${messageId} not mounted, abort scroll`);
        return false;
    }

    try {
        const rootRect = root.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const target = Math.max(0, root.scrollTop + (elRect.top - rootRect.top) + CONFIG.SCROLL_OFFSET_PX);
        ttlog.action(`scroll -> #${messageId} (fallback)`, { from: Math.round(root.scrollTop), to: Math.round(target) });
        root.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });

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
            root.scrollTo({ top: Math.max(0, root.scrollTop + delta), behavior: 'auto' });
        }
        ttlog.warn(`landing unstable after ${CONFIG.SCROLL_VERIFY_TRIES} tries -> #${messageId}`);
        return true;
    } catch (e) {
        ttlog.error(`scroll -> #${messageId} failed`, e instanceof Error ? e.message : String(e));
        return false;
    }
}

// --------------------------------------------------------
// 6. 手动功能 —— 回顶 / 上一条 / 下一条角色回复
//    导航参考楼层：/chat-jump 是居中落点，跳完视口顶不再是目标楼层，
//    若每次都按视口顶算会跳乱/漏楼。记住上次导航目标；用户明显滚开
//    （视口顶远离记忆点）则按视口顶算。CHAT_CHANGED 时清空。
// --------------------------------------------------------
let lastNavTarget: number | null = null;

function navReferenceId(currentId: number): number {
    if (lastNavTarget !== null && Math.abs(currentId - lastNavTarget) <= CONFIG.NAV_REF_TOLERANCE) {
        return lastNavTarget;
    }
    return currentId;
}

async function scrollCurrentMessageToTop(): Promise<void> {
    const currentId = getCurrentVisibleMessageId();
    const targetId = currentId ?? getLastMessageIdSafe();
    if (targetId === null) {
        ttlog.warn('top: no floor found (viewport empty, chat empty)');
        toast('未找到当前消息', 'error');
        return;
    }
    const res = await jumpToFloor(targetId);
    if (!res.ok) ttlog.warn(`top failed -> #${targetId}`);
    else lastNavTarget = targetId;
    toast(res.ok ? `已定位楼层 #${targetId}` : '定位失败', res.ok ? 'success' : 'error');
}

async function navigateAssistantReply(direction: -1 | 1): Promise<void> {
    const currentId = getCurrentVisibleMessageId();
    if (currentId === null) {
        ttlog.warn('nav: viewport floor not found');
        toast('未找到当前消息', 'error');
        return;
    }
    const ids = getAssistantFloorIds();
    if (ids.length === 0) {
        // 失败必须留痕（toast 完就 return、日志零痕迹无法排障的教训）
        ttlog.warn('nav: no assistant floor found', { chatLen: getChat().length, fromId: currentId });
        toast('没找到角色回复', 'warning');
        return;
    }
    const refId = navReferenceId(currentId);

    let target: number | null = null;
    if (direction < 0) {
        for (let i = ids.length - 1; i >= 0; i--) {
            if (ids[i] < refId) {
                target = ids[i];
                break;
            }
        }
        if (target === null) {
            ttlog.nav(`nav prev at first (ref #${refId}, ${ids.length} replies)`);
            toast('已经是第一条角色回复', 'info');
            return;
        }
    } else {
        for (const id of ids) {
            if (id > refId) {
                target = id;
                break;
            }
        }
        if (target === null) {
            ttlog.nav(`nav next at last (ref #${refId}, ${ids.length} replies)`);
            toast('已经是最后一条角色回复', 'info');
            return;
        }
    }

    const res = await jumpToFloor(target);
    if (res.ok) {
        lastNavTarget = target;
        toast(`${direction < 0 ? '已跳到上一条' : '已跳到下一条'}角色回复：#${target}`, 'success');
        ttlog.nav(`${direction < 0 ? 'prev' : 'next'} #${refId} -> #${target} (${res.mode})`);
    } else {
        ttlog.warn(`nav ${direction < 0 ? 'prev' : 'next'} -> #${target} failed`);
        toast('定位失败', 'error');
    }
}

// --------------------------------------------------------
// 7. 自动回顶 —— 主触发：#mes_stop 可见→隐藏（整条生成管线空闲）
//    加固：静默窗口内 MESSAGE_UPDATED / 楼层重渲染会顺延计时
//    开关状态经 nav store（Pinia）读写，持久化在统一存储全局域。
// --------------------------------------------------------
const autoTop = {
    settleTimer: null as ReturnType<typeof setTimeout> | null,
    settleFirstAt: 0,     // 本轮静默窗口的起点（用于 MAX_SETTLE_MS 兜底）
    lastGenerationActive: null as boolean | null,
    observer: null as MutationObserver | null,
};

function autoTopEnabled(): boolean {
    return useNavStore().autoTop;
}

function setAutoTopEnabled(enabled: boolean): void {
    useNavStore().setAutoTop(enabled);
}

// 生成是否进行中：主干用 $('#mes_stop').css('display') 切换（TT script.js:4448-4454）
function isGenerationActive(): boolean {
    const stop = document.querySelector(CONFIG.SEL.STOP_BUTTON);
    if (!(stop instanceof HTMLElement)) return false;
    if (stop.style.display === 'none') return false;
    if (stop.classList.contains('displayNone')) return false;
    const display = stop.style.display || window.getComputedStyle(stop).display;
    return display !== 'none' && display !== '';
}

function clearSettleTimer(): void {
    if (autoTop.settleTimer !== null) {
        clearTimeout(autoTop.settleTimer);
        autoTop.settleTimer = null;
    }
}

function scheduleAutoTop(): void {
    const now = Date.now();
    if (autoTop.settleTimer === null) autoTop.settleFirstAt = now;
    clearSettleTimer();
    if (now - autoTop.settleFirstAt >= CONFIG.MAX_SETTLE_MS) {
        ttlog.action('settle max wait reached, auto-top now');
        void runAutoTop();
        return;
    }
    autoTop.settleTimer = setTimeout(() => {
        autoTop.settleTimer = null;
        void runAutoTop();
    }, CONFIG.SETTLE_MS);
}

// 生成结束后仍有渲染活动（MVU 改写/楼层重渲染）时顺延静默窗口
function bumpSettle(): void {
    if (autoTop.settleTimer !== null) {
        scheduleAutoTop();
    }
}

async function runAutoTop(): Promise<void> {
    try {
        if (!autoTopEnabled()) {
            return;
        }
        const targetId = getLastMessageIdSafe();
        if (targetId === null) {
            ttlog.warn('auto-top: no floor to jump');
            return;
        }
        const res = await jumpToFloor(targetId);
        if (res.ok) {
            ttlog.action(`auto-top -> #${targetId} (${res.mode})`);
        } else {
            ttlog.warn('auto-top failed');
        }
    } catch (e) {
        ttlog.error('auto-top error', e instanceof Error ? e.message : String(e));
    }
}

function checkGenerationIdle(): void {
    const active = isGenerationActive();
    const wasActive = autoTop.lastGenerationActive;
    autoTop.lastGenerationActive = active;
    if (wasActive && !active) {
        if (autoTopEnabled()) scheduleAutoTop();
    }
}

function startGenerationWatch(): void {
    const Obs = window.MutationObserver;
    const stop = document.querySelector(CONFIG.SEL.STOP_BUTTON);
    const send = document.querySelector(CONFIG.SEL.SEND_BUTTON);
    if (!Obs || (!stop && !send)) {
        ttlog.warn('generation watch unavailable', { observer: !!Obs, stop: !!stop, send: !!send });
        return;
    }
    autoTop.lastGenerationActive = isGenerationActive();
    autoTop.observer = new Obs(() => {
        try {
            checkGenerationIdle();
        } catch (e) {
            ttlog.error('generation check error', e instanceof Error ? e.message : String(e));
        }
    });
    const options: MutationObserverInit = { attributes: true, attributeFilter: ['style', 'class'] };
    if (stop) autoTop.observer.observe(stop, options);
    if (send) autoTop.observer.observe(send, options);
    ttlog.info('generation watch started', { stop: !!stop, send: !!send });
}

async function toggleAutoTop(): Promise<void> {
    const next = !autoTopEnabled();
    setAutoTopEnabled(next);
    toast(`自动回顶已${next ? '开启' : '关闭'}`, next ? 'success' : 'info');
    ttlog.info(`auto-top toggled ${next ? 'on' : 'off'}`);
}

// --------------------------------------------------------
// 8. 入口接线 —— TT 原生快速回复（QR）栏 + slash 命令。
//    命令是主体、QR 集是按钮化包装：QR 扩展不可用时命令通道仍独立
//    可用，不静默降级。
// --------------------------------------------------------
const QR_SET_NAME = 'tt-toolkit 导航';
// QR 集末位的「工具箱」按钮（用户拍板的入口形态：比魔棒菜单顺手）。
// message 指向 shell 注册的命令——TOOLBOX_COMMAND 常量由 shell 导出，
// 命令名字面量全仓唯一（防双侧硬编码漂移静默断链）。
const TOOLBOX_QR = Object.freeze({
    label: '工具箱',
    title: '打开 TT 工具箱',
    message: `/${TOOLBOX_COMMAND}`,
});
// quickReplyApi 等待轮询参数（QR 扩展 init 同步挂载 api、先于 APP_READY，
// 但扩展加载顺序不受本模块控制，等待期按最坏情况放宽）
const QR_POLL_INTERVAL_MS = 250;
const QR_POLL_MAX_TRIES = 40;

// 命令表＝slash 注册与 QR 按钮的单一事实源
const NAV_ACTIONS = Object.freeze([
    { command: 'ttnav-top', label: '回顶', title: '当前消息回顶：视口顶楼层对齐到顶', run: (): Promise<void> => scrollCurrentMessageToTop() },
    { command: 'ttnav-prev', label: '上一条', title: '跳到上一条角色回复', run: (): Promise<void> => navigateAssistantReply(-1) },
    { command: 'ttnav-next', label: '下一条', title: '跳到下一条角色回复', run: (): Promise<void> => navigateAssistantReply(1) },
    { command: 'ttnav-auto', label: '自动回顶', title: '自动回顶开关：生成结束后跳回最新楼层', run: (): Promise<void> => toggleAutoTop() },
] as const);

interface QuickReplyLike {
    message?: string;
}

// quickReplyApi 的方法面（TauriTavern src/scripts/extensions/quick-reply/
// api/QuickReplyApi.js 核实：getSetByName :33 / getQrByLabel :44 /
// createQuickReply :203 / updateQuickReply :263 / addGlobalSet :111 /
// async createSet :383）
interface QuickReplyApiLike {
    getSetByName(name: string): unknown;
    createSet(name: string): Promise<void>;
    getQrByLabel(setName: string, label: string): QuickReplyLike | null | undefined;
    createQuickReply(setName: string, label: string, props: { message: string; title?: string }): Promise<unknown>;
    updateQuickReply(setName: string, label: string, props: { message: string }): Promise<unknown>;
    addGlobalSet(name: string): Promise<unknown>;
}

function getQuickReplyApi(): QuickReplyApiLike | null {
    const api = hostWindow.quickReplyApi;
    return typeof api === 'object' && api !== null ? (api as QuickReplyApiLike) : null;
}

// 三段等待：立查 → APP_READY（autoFire 事件，晚订阅会立即重放，不悬挂）
// → 轮询兜底；APP_READY 已发而 api 仍缺席＝QR 扩展被禁用，立即认定失败
async function waitForQuickReplyApi(): Promise<QuickReplyApiLike | null> {
    const immediate = getQuickReplyApi();
    if (immediate) return immediate;

    await new Promise<void>(resolve => {
        let settled = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        // 单一出口：finish 自清轮询——APP_READY 晚订阅同步重放可能先于
        // setInterval 创建而 settle，此时不再起轮询（防 detached 计时器
        // 空转到 deadline）
        const finish = () => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearInterval(timer);
            resolve();
        };
        try {
            eventBus.once(event_types.APP_READY, finish);
        } catch (e) {
            ttlog.warn('APP_READY subscribe failed, poll only', e instanceof Error ? e.message : String(e));
        }
        if (!settled) {
            const deadline = Date.now() + QR_POLL_INTERVAL_MS * QR_POLL_MAX_TRIES;
            timer = setInterval(() => {
                if (getQuickReplyApi() || Date.now() >= deadline) finish();
            }, QR_POLL_INTERVAL_MS);
        }
    });
    return getQuickReplyApi();
}

function qrActivated(): boolean {
    return getNavState().qrActivated;
}

function markQrActivated(): void {
    setNavState({ qrActivated: true });
}

async function ensureNavQrSet(): Promise<void> {
    const api = await waitForQuickReplyApi();
    if (!api) {
        // fail fast：QR 栏缺席要让用户看见，且明说替代入口（命令通道独立于 QR）
        console.warn(`[tt-toolkit][nav] ${NAV_VERSION}: quickReplyApi unavailable, QR bar not created; /ttnav-* commands remain available`);
        ttlog.warn('quickReplyApi unavailable after wait, QR bar skipped');
        toast('快速回复不可用：命令已注册为 /ttnav-*，可在输入框直接执行', 'warning');
        return;
    }

    try {
        // createSet 对同名集是原位替换语义（丢集内全部 QR），仅在集不存在时
        // 调用；已存在只逐条补缺/对齐 message，不触 updateSet/deleteSet
        // （保护用户对集属性与按钮的自定义）
        if (!api.getSetByName(QR_SET_NAME)) {
            await api.createSet(QR_SET_NAME);
        }
        for (const action of NAV_ACTIONS) {
            const qr = api.getQrByLabel(QR_SET_NAME, action.label);
            if (!qr) {
                await api.createQuickReply(QR_SET_NAME, action.label, {
                    message: qrMessage(action),
                    title: action.title,
                });
            } else if (qr.message !== qrMessage(action)) {
                await api.updateQuickReply(QR_SET_NAME, action.label, {
                    message: qrMessage(action),
                });
            }
        }

        // 工具箱按钮＝集末位第五键，补缺/对齐纪律与导航四键一致
        // （已存在只对齐 message，保护用户自定义）。建键前先校验命令
        // 在场：壳侧注册被占（重名）时按钮会静默指向别人的命令——
        // fail fast，跳过建键并留痕，四键导航不受影响
        if (!isSlashCommandRegistered(TOOLBOX_COMMAND)) {
            toast(`工具箱入口未建立：/${TOOLBOX_COMMAND} 命令不在场`, 'warning');
            ttlog.warn(`toolbox QR skipped: /${TOOLBOX_COMMAND} not registered`);
        } else {
            const qr = api.getQrByLabel(QR_SET_NAME, TOOLBOX_QR.label);
            if (!qr) {
                await api.createQuickReply(QR_SET_NAME, TOOLBOX_QR.label, {
                    message: TOOLBOX_QR.message,
                    title: TOOLBOX_QR.title,
                });
            } else if (qr.message !== TOOLBOX_QR.message) {
                await api.updateQuickReply(QR_SET_NAME, TOOLBOX_QR.label, {
                    message: TOOLBOX_QR.message,
                });
            }
        }

        // 激活一次制：仅首次把集挂入全局列表并置位；用户此后手动移除该集
        // 不复活（尊重用户对快速回复栏的自主管理）
        if (!qrActivated()) {
            await api.addGlobalSet(QR_SET_NAME);
            markQrActivated();
        }
        ttlog.info(`QR set "${QR_SET_NAME}" ready (activated=${qrActivated()}, buttons=${NAV_ACTIONS.length + 1} 含工具箱)`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ttlog.error('QR set ensure failed', msg);
        toast(`导航快速回复建立失败[${NAV_VERSION}]：${msg}`, 'error');
    }
}

// QR message＝slash 命令本体，不带尾空格——宿主执行时会自行拼接：
// QuickReplySet.js:160 executeWithOptions 的 else 分支
// `input = `${finalMessage} ` `，自带尾空格成冗余
function qrMessage(action: { command: string }): string {
    return `/${action.command}`;
}

function registerSlashCommands(): void {
    for (const action of NAV_ACTIONS) {
        // host 层 registerSlashCommand 内建重名 pre-check（addCommandObject
        // 静默覆盖坑，见 host/slash.ts 核实记录）
        const ok = registerSlashCommand({
            name: action.command,
            helpString: action.title,
            callback: async () => {
                // 错误表面化：入口异常必须 toast 给用户，不许只留日志
                try {
                    await action.run();
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    toast(`导航出错[${NAV_VERSION}]：${msg}`, 'error');
                    ttlog.error(`/${action.command} handler error`, msg);
                }
                return '';
            },
        });
        if (ok) ttlog.info(`slash command registered: /${action.command}`);
    }
    ttlog.info(`slash commands registration pass done: ${NAV_ACTIONS.map(a => `/${a.command}`).join(' ')}`);
}

// --------------------------------------------------------
// 9. 事件与排障口
// --------------------------------------------------------
function bindEvents(): void {
    // 渲染活动顺延静默窗口（MVU 改写正文、楼层重渲染）
    eventBus.on(event_types.MESSAGE_UPDATED, bumpSettle);
    eventBus.on(event_types.CHARACTER_MESSAGE_RENDERED, bumpSettle);

    // 切换聊天时丢弃未完成的自动回顶与楼层记忆点（新聊天楼号重排）
    eventBus.on(event_types.CHAT_CHANGED, () => {
        clearSettleTimer();
        lastNavTarget = null;
        ttlog.info('chat changed, pending auto-top dropped, nav ref cleared');
    });
}

// 无 UI 排障口：主窗口 devtools 直取 __TT_NAV__.dump()；
// node 冒烟（无 DOM）下输出降级视图（root/genActive 标 n/a），不抛错
function dump(): string {
    const noDom = typeof document === 'undefined';
    const root = noDom ? null : getScrollRoot();
    const lines = [
        `tt-toolkit nav dump @ ${new Date().toISOString()}`,
        `version=${NAV_VERSION} autoTop=${autoTopEnabled() ? 'on' : 'off'} ttlog=${ttlogHealth()} mode=${lastJumpMode ?? 'none'} jumpExecutor=${jumpExecutorAvailable() ? 'present' : 'absent'}`,
        `qrApi=${getQuickReplyApi() ? 'ready' : 'unavailable'} qrSet="${QR_SET_NAME}" qrActivated=${qrActivated()}`,
        `root=${root ? `#${root.id || '(no id)'}` : noDom ? 'n/a (no DOM)' : 'missing'}`
            + ` mounted=${root ? root.querySelectorAll(CONFIG.SEL.MESSAGE).length : 0}`
            + ` lastId=${getLastMessageIdSafe()} genActive=${noDom ? 'n/a' : isGenerationActive()}`,
        '--- ring (oldest first) ---',
        ...ttlog.getBuffer().map(e => `${e.timestamp} [${e.type}] ${e.message}${e.data !== null && e.data !== undefined ? ` | ${safeDumpText(e.data)}` : ''}`),
    ];
    return lines.join('\n');
}

// --------------------------------------------------------
// 10. 初始化 —— 显式导出，由 main.ts 统一做环境分支（加载完成不加
//     toast：console 的模块 ready 日志即载体）。
//     浏览器流调 initNav()（全量），node 冒烟流调 initNavMinimal()
//     （无 DOM 最小集）。模块求值期不自启动，时序主权在引导层。
// --------------------------------------------------------

/** 浏览器全量初始化：命令注册 + QR 集建立 + 事件接线 + 生成监听。 */
export function initNav(): void {
    const start = (): void => {
        registerSlashCommands();
        void ensureNavQrSet(); // 异步等 QR API 就绪，不阻塞命令注册与事件接线
        bindEvents();
        startGenerationWatch();
        ttlog.info(`${NAV_VERSION} loaded autoTop=${autoTopEnabled() ? 'on' : 'off'} mode=${lastJumpMode ?? 'none'} jumpExecutor=${jumpExecutorAvailable() ? 'present' : 'absent'} ttlog=${ttlogHealth()}`);
    };
    // 防御性等待：扩展脚本正常晚于 DOM 就绪，但 readyState 仍为 loading
    // 时（宿主加载流程变更）不应在半初始化的 DOM 上接线
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => start());
        return;
    }
    start();
}

/** node 冒烟最小初始化：只做不依赖 DOM/QR 的命令注册与事件绑定。 */
export function initNavMinimal(): void {
    registerSlashCommands();
    bindEvents();
    ttlog.info(`${NAV_VERSION} minimal init (node smoke) autoTop=${autoTopEnabled() ? 'on' : 'off'} ttlog=${ttlogHealth()}`);
}

const flagWindow = globalThis as Record<string, unknown>;

if (flagWindow[NAV_FLAG]) {
    console.warn('[tt-toolkit][nav] already loaded, skip re-injection');
} else {
    flagWindow[NAV_FLAG] = true;
    // 排障口先挂（不依赖 DOM、不触发初始化）：node 冒烟路径也要能用
    // dump 验证模块在场
    flagWindow.__TT_NAV__ = Object.freeze({ version: NAV_VERSION, dump });
}
