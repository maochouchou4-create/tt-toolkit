/**
 * summary 事件接线：MESSAGE_RECEIVED 自动触发守卫链＋CHAT_CHANGED 生命周期＋启动挂载。
 *
 * 守卫顺序（越早越便宜，choice/auto.ts 同款骨架）：分组形态 → autoEnabled →
 * 生成中 → 端点在场 → 算术达标，全部通过后 fire-and-forget。监听器内不得
 * await（宿主 eventSource.emit 串行 await 每个监听器，重活脱钩理由见
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

import { eventBus, event_types, showToast } from '@/host';
import { resolveActiveEndpoint } from '@/modules/apis/storage';
import { planAutoSmallSummary } from './arithmetic';
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
        // busy 进不来（守卫链 isSummaryRunning 先拦）；skipped/cancelled 静默是
        // 纪律（自动跳过不打扰、取消无可见变更）；big-done 不出现在自动路径
        // （级联大总结结果折进 small-done 的 bigRan/bigError 字段）。
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
 * 自动触发守卫链本体（导出仅供冒烟直调；浏览器路径经 eventBus 进来）。
 * 同步返回：通过全部守卫时 runSmallSummary 已启动，本函数不等待它完成。
 */
export function handleSummaryMessageReceived(messageId: unknown): boolean {
    // 分组消息 emit 形态是 (chat_id, type)——非整数一律不当楼层索引
    // （chat_id 恰为纯数字串时 Number() 兜底会误判成楼层，choice/auto.ts:47 同款）
    if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId < 0) return false;

    const settings = readSummarySettings();
    if (!settings.autoEnabled) return false;

    if (isSummaryRunning()) return false;

    if (!resolveActiveEndpoint()) {
        // 不弹 UI（AI 刚回复完抢焦点体验极差，choice 同口径）；留 console 线索供排障
        console.warn('[tt-toolkit][summary] 自动总结跳过：未选择生成端点');
        return false;
    }

    if (planAutoSmallSummary(rawFloorIndices().length, settings.intervalRounds, settings.keepRounds).batchSize < 2) return false;

    // fire-and-forget：立即返回，生成在后台跑；running 镜像与结果分发在
    // settle 侧收口（store 状态行据此把操作行换成生成中形态）
    const store = useSummaryStore();
    store.beginRun('small');
    void runSmallSummary({ auto: true })
        .then(reportAutoOutcome)
        .finally(() => {
            store.endRun();
            store.resync();
        });
    return true;
}
