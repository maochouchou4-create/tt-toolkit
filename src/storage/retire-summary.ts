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
 * 通道分工：读面走 storage 服务的域读取（与其它子域同一条通道，取的是域
 * 对象原始单例不比快照），写面直访 host 层 settings——域键登记面只登记在用
 * 的子域，退役键名脱离 GlobalDomain/ChatDomain union 正是「已不在用」的
 * 类型级表达；而服务的写口是整键替换、做不了 delete，故直访域对象。
 *
 * 机判半在 retire-summary-smoke.ts（批 A 拆出）：smoke 名不经桶导出，
 * 防止冒烟面经静态图回流浏览器加载面。
 */

import { writeChatMetadata, writeExtensionSettings } from '@/host';
import { CHAT_KEY, GLOBAL_KEY, readChatDomain, readGlobalDomain } from './service';
import { isRecord } from './shape';

/** 退役域键名（全局域与聊天域同名两处；字面量仅此一份）。 */
export const RETIRED_KEY = 'summary';

/**
 * 域内是否还挂着退役键（缺席＝已完成，删除与读取都以它为门）。
 * 导出＝smoke 侧判别式共用同一谓词（种入/删后缺席同判别式，单源）。
 */
export function hasRetiredKey(domain: unknown): boolean {
    return isRecord(domain) && RETIRED_KEY in domain;
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
        if (hasRetiredKey(readGlobalDomain())) {
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
        if (hasRetiredKey(readChatDomain())) {
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
