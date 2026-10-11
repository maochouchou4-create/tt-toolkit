/**
 * summary 事件接线：MESSAGE_RECEIVED 自动触发守卫链＋CHAT_CHANGED 生命周期＋启动挂载。
 *
 * 守卫顺序（越早越便宜，choice/auto.ts 同款骨架）：分组形态 → autoEnabled →
 * 生成中 → 任务模型在场 → 算术达标（达标即启动，fire-and-forget）。监听器内
 * 不得 await（宿主 eventSource.emit 串行 await 每个监听器，重活脱钩理由见
 * host/events.ts 头注）；runSmallSummary 在首个 await 前同步置位并发锁，
 * 守卫与脱钩之间无竞态窗口。
 *
 * quiet 不滤（与 choice 自动出选项刻意相反）：choice 只对真 AI 回复出选项，
 * 总结按楼层计数，quiet 楼层也是剧情内容——这是设计而非疏漏。
 *
 * 与 choice 的自动出选项监听并存是预期：两监听器各自 fire-and-forget 并发
 * 后台任务；本模块的 hideFloors 会让进行中的 choice 生成读到变短的历史窗口
 * （历史变短非错位，语义无害）。
 *
 * toast 分发纪律：自动路径只对可见变更出声——small-done 成功 toast、failed
 * 错误 toast；skipped/cancelled 静默（skipped reason 是机制语言，不进用户
 * toast）。手动路径的 toast 归 store（UI 层）。
 */

import { eventBus, event_types, getChatMessages, isHostErrorText, showToast } from '@/host';
import { resolveTaskRoute } from '@/modules/apis/task-profiles';
import { autoTriggerDue } from './arithmetic';
import { cancelSummaryGeneration, isSummaryRunning, runSmallSummary, type SummaryRunOutcome } from './generator';
import { readSummarySettings } from './settings';
import { resyncSummarySlot } from './slot';
import { rawFloorIndices, selfHealSummaryState } from './state';
import { useSummaryStore } from './store';

/** 幂等安装标记（浏览器 init 单次调用；守卫本体导出仅供冒烟直调）。 */
let installed = false;

/** 自动路径结果分发（小总结含级联大总结的失败面；穷尽 switch——加 kind 落空即编译错）。 */
function reportAutoOutcome(outcome: SummaryRunOutcome): void {
    switch (outcome.kind) {
        case 'small-done':
            showToast(`自动小总结完成：${outcome.foldedFloors} 楼已折叠`, 'success');
            if (outcome.bigError !== undefined) showToast(`大总结失败：${outcome.bigError}`, 'error');
            return;
        case 'failed':
            showToast(`小总结失败：${outcome.message}`, 'error');
            return;
        // busy 被守卫链入口的同步防线拦下，保留静默兜底；skipped/cancelled
        // 静默是纪律（自动跳过不打扰、取消无可见变更）；big-done 不出现在
        // 自动路径（级联大总结结果折进 small-done 的 bigRan/bigError 字段）。
        case 'busy':
        case 'skipped':
        case 'cancelled':
        case 'big-done':
            return;
    }
}

/** 安装自动触发与聊天切换监听（幂等）。 */
export function installSummaryAuto(): void {
    if (installed) return;
    installed = true;
    eventBus.on(event_types.MESSAGE_RECEIVED, (...args: unknown[]) => {
        // 只透传 messageId：quiet 类型不滤（文件头设计声明），type 无消费
        return handleSummaryMessageReceived(args[0]);
    });
    eventBus.on(event_types.CHAT_CHANGED, handleChatChanged);
}

/**
 * CHAT_CHANGED 生命周期：abort in-flight → 自愈 → 重挂/清槽 → store 刷新。
 * 槽是宿主全局单例，切聊天不重挂＝上一聊天的摘要注入新聊天（最大串味
 * 风险）；abort 后 in-flight 的成功路径不可能再动状态（取消边界在 hide
 * 之前——生成失败/取消不写任何楼层与聊天域）。
 */
function handleChatChanged(): void {
    cancelSummaryGeneration();
    selfHealSummaryState();
    resyncSummarySlot();
    useSummaryStore().resync();
}

/**
 * 自动路径启动小总结（fire-and-forget：running 镜像与结果分发在 settle 侧收口）。
 */
function fireSmallSummary(): void {
    if (isSummaryRunning()) return;
    const store = useSummaryStore();
    store.beginRun('small');
    void runSmallSummary({ auto: true })
        .then(reportAutoOutcome)
        .finally(() => {
            store.endRun();
            store.resync();
        });
}

/**
 * 自动触发守卫链本体（导出仅供冒烟直调；浏览器路径经 eventBus 进来）。
 * 同步返回：达标时 runSmallSummary 已启动（true）；本函数不等待它完成。
 */
export function handleSummaryMessageReceived(messageId: unknown): boolean {
    // 分组消息 emit 形态是 (chat_id, type)——非整数一律不当楼层索引
    // （chat_id 恰为纯数字串时 Number() 兜底会误判成楼层，choice/auto.ts:47 同款）
    if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId < 0) return false;

    // 宿主错误楼层跳过：宿主把生成失败伪装成一条正常回复落地（判据本体与
    // 出处见 host/api-error.ts）。summary 与 choice 的关键差别——这里不是
    // 「出不出选项」而是「会不会把错误正文当剧情」：错误正文一旦进
    // 总结源文本（generator.buildSmallSourceText 逐楼取 mes），产出的就是
    // 一段总结错误的假摘要，且会经槽注入进后续所有对话。quiet 不滤是设计
    // （quiet 楼层也是剧情），但错误正文不是剧情。
    const chat = getChatMessages();
    const floor = messageId < chat.length ? chat[messageId] : undefined;
    if (isHostErrorText(floor?.mes)) return false;

    const settings = readSummarySettings();
    if (!settings.autoEnabled) return false;

    if (isSummaryRunning()) return false;

    if (!resolveTaskRoute('summary_small')) {
        // 不弹 UI（AI 刚回复完抢焦点体验极差，choice 同口径）；留 console 线索供排障
        console.warn('[tt-toolkit][summary] 自动总结跳过：任务模型未配置——到「API」页「任务模型」卡给「小总结」配置服务商与模型');
        return false;
    }

    const rawCount = rawFloorIndices().length;
    if (!autoTriggerDue(rawCount, settings.intervalRounds, settings.keepRounds)) return false;

    fireSmallSummary();
    return true;
}
