/**
 * TT 宿主日志转发器（createTtlog 工厂，nav 模块消费）。
 *
 * 机制（与旧 shared/log.js 同源，收编进 host 层）：
 *   - 环形缓冲 LOG_RING_MAX 条：进程内实时视图，getBuffer() 消费；
 *   - 批量防抖 FLUSH_MS 直调宿主内部命令 devlog_append_frontend_logs，
 *     落盘 tauritavern.log.YYYY-MM-DD（对齐 TT 自身 FLUSH_INTERVAL_MS）；
 *     定性：对内部命令的知情依赖（TT docs/API/Dev.md 明示 devlog_* 非公开
 *     契约，公开 ABI 无写入方法）；
 *   - 单条截断 MAX_CHARS，防超长日志拖垮 IPC；
 *   - 探测失败 / invoke 出错 → 本会话熔断降级（degraded）：只丢持久日志，
 *     ERROR/WARN 仍有 console，不影响任何功能；
 *   - 日志语义：只记楼层号/操作/错误栈等排障事实，不记消息正文。
 */

const LOG_RING_MAX = 200;
const FLUSH_MS = 250;
const MAX_CHARS = 3072;

export type TtlogType = 'INFO' | 'ACTION' | 'NAV' | 'WARN' | 'ERROR';

export interface TtlogEntry {
    timestamp: string;
    type: TtlogType;
    message: string;
    data: unknown;
}

export interface Ttlog {
    info(message: string, data?: unknown): void;
    action(message: string, data?: unknown): void;
    nav(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
    flush(): void;
    getBuffer(): TtlogEntry[];
}

interface TauriWindow {
    __TAURI__?: { core?: { invoke?: unknown } };
    __TAURITAVERN__?: { core?: { invoke?: unknown } };
}

// TTLOG 分级：INFO/ACTION/NAV → info；WARN → warn；ERROR → error
function ttLevel(type: TtlogType): 'info' | 'warn' | 'error' {
    if (type === 'ERROR') return 'error';
    if (type === 'WARN') return 'warn';
    return 'info';
}

// 安全序列化：Error → message+stack；循环引用/异常对象不炸转发器
function safeText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, (_k, v) => (v instanceof Error ? v.stack || String(v) : v)) ?? String(value);
    } catch {
        return String(value);
    }
}

function clipText(text: string): string {
    return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}

export function createTtlog(target: string): Ttlog {
    const ring: TtlogEntry[] = [];
    const state = {
        degraded: false,   // 熔断：本会话不再尝试直调
        invoke: null as ((command: string, args: unknown) => unknown) | null,
        queue: [] as { level: string; target: string; message: string }[],
        timer: null as ReturnType<typeof setTimeout> | null,
    };

    // 探测宿主 invoke：认 __TAURI__ / __TAURITAVERN__ 双 ABI（任一暴露 core.invoke 即用）
    function initTtlog(): void {
        try {
            const w = globalThis as unknown as TauriWindow;
            const core = w.__TAURI__?.core ?? w.__TAURITAVERN__?.core;
            const invoke = core?.invoke;
            if (typeof invoke === 'function') {
                state.invoke = invoke.bind(core) as (command: string, args: unknown) => unknown;
                return;
            }
        } catch {
            // 缺失即降级
        }
        state.degraded = true;
    }

    function flush(): void {
        state.timer = null;
        if (state.queue.length === 0 || !state.invoke) return;
        const entries = state.queue.splice(0, state.queue.length);
        try {
            const res = state.invoke('devlog_append_frontend_logs', { entries });
            Promise.resolve(res).catch(() => {
                state.degraded = true;
            });
        } catch {
            state.degraded = true;   // 熔断：本会话只走 console + 环形缓冲
        }
    }

    function pushTtlog(type: TtlogType, message: string, data: unknown): void {
        if (state.degraded || !state.invoke) return;
        const text = safeText(message) + (data !== null && data !== undefined ? ` | ${safeText(data)}` : '');
        state.queue.push({ level: ttLevel(type), target, message: clipText(text) });
        if (state.timer === null) state.timer = setTimeout(flush, FLUSH_MS);
    }

    function log(type: TtlogType, message: string, data: unknown): void {
        const timestamp = new Date().toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            fractionalSecondDigits: 3,
        });
        ring.push({ timestamp, type, message, data });
        if (ring.length > LOG_RING_MAX) {
            ring.splice(0, ring.length - LOG_RING_MAX);
        }
        if (type === 'ERROR') console.error(`[tt-toolkit][${target}][${type}]`, message, data ?? '');
        else if (type === 'WARN') console.warn(`[tt-toolkit][${target}][${type}]`, message, data ?? '');
        pushTtlog(type, message, data);
    }

    initTtlog();

    return {
        info: (message, data) => log('INFO', message, data ?? null),
        action: (message, data) => log('ACTION', message, data ?? null),
        nav: (message, data) => log('NAV', message, data ?? null),
        warn: (message, data) => log('WARN', message, data ?? null),
        error: (message, data) => log('ERROR', message, data ?? null),
        flush,
        getBuffer: () => ring.slice(),
    };
}
