/**
 * nav CONFIG 常量、版本戳与日志/等待小件。
 *
 * 日志转发器在 host/ttlog（环形缓冲 + 批量防抖直调宿主日志命令）；nav
 * 只接线。熔断降级只丢持久日志，不影响功能。
 */

import { createTtlog, type Ttlog } from '@/host';

// 版本戳：加载日志 / dump / 错误 toast 全带版本，现场排障可区分运行的
// 是哪一版（两版同名 nav-v1 时日志无法归因的教训）
export const NAV_VERSION = 'nav-v4';

// --------------------------------------------------------
// CONFIG —— 所有可调参数集中在这里（与 v2 同值）
// --------------------------------------------------------
export const CONFIG = Object.freeze({
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
    // DOM 契约（TauriTavern 主干）
    SEL: Object.freeze({
        SCROLL_ROOT: '#chat',          // 滚动容器（chatSurface 的 root）
        MESSAGE: '.mes[mesid]',        // 楼层节点
        STOP_BUTTON: '#mes_stop',      // 生成期间显示的“暂停”按钮
        SEND_BUTTON: '#send_but',      // 空闲时的“发送”按钮
    }),
});

export const ttlog: Ttlog = createTtlog('msgnav');

// dump 排障口的数据序列化与转发器同规则（host/ttlog safeText 单点：
// Error 给栈、嵌套 Error 走 replacer、循环引用不炸）
// host/ttlog 不暴露熔断态，dump 以宿主 invoke ABI 可用性作同阶诊断
export function ttlogHealth(): string {
    const invoke = (globalThis as { __TAURI__?: { core?: { invoke?: unknown } }; __TAURITAVERN__?: { core?: { invoke?: unknown } } })
        .__TAURI__?.core?.invoke
        ?? (globalThis as { __TAURITAVERN__?: { core?: { invoke?: unknown } } }).__TAURITAVERN__?.core?.invoke;
    return typeof invoke === 'function' ? 'ok' : 'unavailable';
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
