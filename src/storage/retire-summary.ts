/**
 * 总结域退役清理。
 *
 * 总结功能整体退役后，旧档里的两个 summary 域键（全局域设置＋聊天域总结态）
 * 再无消费者——留着只会在排障 dump 里让人以为功能还在。
 *
 * 与 legacy-wipe 的语义相反：那边是「一次性」清理（legacyWipeDone 标记在场
 * 即整段短路），本段每次启动都跑、幂等无标记——键缺席＝已完成，不炸启动；
 * 清理失败只 warn：退役清理做不完不该让整个工具箱打不开。
 *
 * 作用域：聊天域只清启动时打开的那个聊天——其余聊天不遍历（不碰旧档的
 * 拍板边界；残留键无消费者、惰性无害）。
 *
 * 通道走 host 层 settings 直访而非 storage 服务的 getGlobal/setGlobal：
 * 域键登记面只登记在用的子域，退役键名脱离 GlobalDomain/ChatDomain union
 * 正是「已不在用」的类型级表达。delete 也没有现成原语（服务的写口是整键
 * 替换），故直访域对象。
 */

import { currentChatMetadata, extension_settings, writeChatMetadata, writeExtensionSettings } from '@/host';
import { CHAT_KEY, GLOBAL_KEY } from './service';

/** 退役域键名（全局域与聊天域同名两处；字面量仅此一份）。 */
const RETIRED_KEY = 'summary';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 域内是否还挂着退役键（缺席＝已完成，删除与读取都以它为门）。 */
function hasRetiredKey(domain: unknown): boolean {
    return isRecord(domain) && RETIRED_KEY in domain;
}

function readGlobalDomainRaw(): unknown {
    return (extension_settings as Record<string, unknown>)[GLOBAL_KEY];
}

function readChatDomainRaw(): unknown {
    return currentChatMetadata()[CHAT_KEY];
}

export interface RetireSummaryReport {
    /** 全局域退役键本次是否真删（false＝上轮已清或读面缺席）。 */
    globalRemoved: boolean;
    /** 聊天域退役键本次是否真删。 */
    chatRemoved: boolean;
}

/**
 * 删两个域键（启动管线调用）。只在键在场时才走宿主写通道——缺席档不触发
 * 全局 settings 防抖落盘、也不空跑一次 chat 域保存。
 */
export function retireSummaryKeys(): RetireSummaryReport {
    const report: RetireSummaryReport = { globalRemoved: false, chatRemoved: false };
    // 两域各自 try：一域失败不得短路另一域，warn 文案各说各的实际尝试范围
    try {
        if (hasRetiredKey(readGlobalDomainRaw())) {
            writeExtensionSettings(settings => {
                const domain = settings[GLOBAL_KEY];
                if (!hasRetiredKey(domain)) return;
                delete (domain as Record<string, unknown>)[RETIRED_KEY];
                report.globalRemoved = true;
            });
        }
    } catch (e) {
        console.warn('[tt-toolkit][storage] 全局域 summary 键清理失败（旧键保留，下次启动重试；不影响其余功能）', e);
    }
    try {
        if (hasRetiredKey(readChatDomainRaw())) {
            writeChatMetadata(metadata => {
                const domain = metadata[CHAT_KEY];
                if (!hasRetiredKey(domain)) return;
                delete (domain as Record<string, unknown>)[RETIRED_KEY];
                report.chatRemoved = true;
            });
        }
    } catch (e) {
        console.warn('[tt-toolkit][storage] 当前聊天 summary 键清理失败（旧键保留，下次启动重试；不影响其余功能）', e);
    }
    return report;
}

// ---------------------------------------------------------------------------
// 烟雾机判（node 冒烟；沿用 [wipe-smoke] 标签，与 legacy-wipe 同属启动期
// 存储清理段，由 scripts/smoke.mjs 的清理段计数单点机判）。
// 判别式用「种进去再删」而不是「读一遍看缺席」——空档恒缺席，只看缺席的
// 断言在清理整段没接线时照样绿。
// ---------------------------------------------------------------------------

const retireFailures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
    console.info(`[wipe-smoke] ${ok ? 'PASS' : 'FAIL'} 退役清理 ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) retireFailures.push(label);
}

/** 场景种子（形状对齐退役前的两处域值；值仅作在场证据，不参与断言）。 */
function seedRetiredKeys(): void {
    const settings = extension_settings as Record<string, unknown>;
    const globalDomain = (isRecord(settings[GLOBAL_KEY]) ? settings[GLOBAL_KEY] : {}) as Record<string, unknown>;
    globalDomain[RETIRED_KEY] = { autoEnabled: true, intervalRounds: 3, keepRounds: 3, bigEvery: 3 };
    settings[GLOBAL_KEY] = globalDomain;
    const metadata = currentChatMetadata();
    const chatDomain = (isRecord(metadata[CHAT_KEY]) ? metadata[CHAT_KEY] : {}) as Record<string, unknown>;
    chatDomain[RETIRED_KEY] = { bigSummary: '旧摘要正文', smallSummaries: [{ text: '旧摘要', fromFloor: 0, toFloor: 3 }] };
    metadata[CHAT_KEY] = chatDomain;
}

export function runRetireSummarySmoke(): void {
    console.info('=== 总结域退役清理机判 ===');

    seedRetiredKeys();
    const report = retireSummaryKeys();
    check('全局域退役键删除后缺席', report.globalRemoved && !hasRetiredKey(readGlobalDomainRaw()));
    check('聊天域退役键删除后缺席', report.chatRemoved && !hasRetiredKey(readChatDomainRaw()));

    const rerun = retireSummaryKeys();
    check('二跑幂等（键缺席不删不炸）', !rerun.globalRemoved && !rerun.chatRemoved);

    // 失败形态：域对象冻住（delete 抛 TypeError）→ 只 warn、启动链继续。
    // 换装的是同一槽位的替身对象，跑完即换回原引用，不动真实域内容。
    const settings = extension_settings as Record<string, unknown>;
    const originalDomain = settings[GLOBAL_KEY];
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    let threw = false;
    try {
        settings[GLOBAL_KEY] = Object.freeze({ [RETIRED_KEY]: { autoEnabled: true } });
        console.warn = (...args: unknown[]) => { warnings.push(args); };
        try {
            retireSummaryKeys();
        } catch {
            threw = true;
        }
    } finally {
        console.warn = originalWarn;
        settings[GLOBAL_KEY] = originalDomain;
    }
    check('删键抛错只 warn 不中断启动', !threw && warnings.length === 1, `warn ${warnings.length} 条`);

    if (retireFailures.length > 0) {
        console.error(`[wipe-smoke] FAIL：退役清理 ${retireFailures.length} 项未过：${retireFailures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[wipe-smoke] OK：退役清理（两域键删除后缺席＋二跑幂等＋失败仅 warn）全部通过。');
}
