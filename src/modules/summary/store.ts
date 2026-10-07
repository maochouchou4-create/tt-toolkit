/**
 * 「总结」tab 的 Pinia store：设置/状态行读数＋手动操作的 toast 分发。
 *
 * 失效信号纪律照 apis/store：存储写穿后 bump revision，getters 读取时
 * void this.revision 建立依赖。resync 三触发点（tab 激活＋每次生成落账
 * 后＋CHAT_CHANGED——tab 常驻挂载下后台自动总结后状态行才会自新）都收
 * 敛到 revision bump，UI 侧无第二套刷新机制。
 *
 * toast 分发：手动路径按方案文案表逐字（skipped reason 本就是用户向
 * 文案——未选端点指引/无可总结/无可合并由 generator 常量给出）；自动
 * 路径的 toast 归 auto.ts。
 */

import { defineStore } from 'pinia';
import { showToast } from '@/host';
import { resolveActiveEndpoint } from '@/modules/apis/storage';
import { roundsToTrigger } from './arithmetic';
import { isSummaryRunning, restoreAllSummaries, runBigSummary, runSmallSummary, type SummaryRunOutcome } from './generator';
import { readSummaryChatState, readSummarySettings, writeSummaryChatState, writeSummarySettings, type SummarySettings } from './settings';
import { resyncSummarySlot } from './slot';
import { hiddenFloorCount, rawFloorIndices } from './state';

export const useSummaryStore = defineStore('tt-summary', {
    state: () => ({
        /** 失效信号：存储/楼层任何变更后自增（读侧 getters 建立依赖）。 */
        revision: 0,
        /** 生成中镜像（small 含级联大总结段；自动路径由 auto.ts 同步置位/清位）。 */
        runningKind: null as 'small' | 'big' | null,
    }),
    getters: {
        settings(): SummarySettings {
            void this.revision;
            return readSummarySettings();
        },
        /** 已折叠楼数（派生，不落第二份）。 */
        hiddenCount(): number {
            void this.revision;
            return hiddenFloorCount();
        },
        /** 未折叠小总结条数。 */
        smallCount(): number {
            void this.revision;
            return readSummaryChatState().smallSummaries.length;
        },
        /** 当前大总结正文（空串＝尚无）。 */
        bigSummary(): string {
            void this.revision;
            return readSummaryChatState().bigSummary;
        },
        /** 状态行「再聊 x 轮触发小总结」：与触发守卫同源纯函数，UI 不另写算式。 */
        roundsLeft(): number {
            void this.revision;
            const s = this.settings;
            return roundsToTrigger(rawFloorIndices().length, s.intervalRounds, s.keepRounds);
        },
        /** 端点行展示（模型名优先，缺席回退 url；未选择态单独文案）。 */
        endpointLabel(): string {
            void this.revision;
            const endpoint = resolveActiveEndpoint();
            if (!endpoint) return '未选择';
            return endpoint.model || endpoint.url;
        },
        isRunning(): boolean {
            return this.runningKind !== null || isSummaryRunning();
        },
    },
    actions: {
        /** 状态刷新单点（三触发点共用）。 */
        resync() {
            this.revision += 1;
        },
        /** 设置写回单通道（写侧归一钳制，UI 只需透传）。 */
        updateSettings(patch: Partial<SummarySettings>) {
            writeSummarySettings({ ...readSummarySettings(), ...patch });
            this.resync();
        },
        /** 大总结编辑保存（人工纠错通道：写回 bigSummary＋重挂槽）。 */
        saveBigSummary(text: string) {
            const state = readSummaryChatState();
            state.bigSummary = text;
            writeSummaryChatState(state);
            resyncSummarySlot();
            this.resync();
        },
        /** 手动小总结（toast：成功/失败/守卫拒绝；取消静默）。 */
        async runManualSmall(): Promise<void> {
            await this.runWithToast('small', () => runSmallSummary({ auto: false }), {
                success: outcome => (outcome.kind === 'small-done' ? `已完成小总结（折叠 ${outcome.foldedFloors} 楼）` : ''),
                failLabel: '小总结失败',
            });
        },
        /** 手动大总结。 */
        async runManualBig(): Promise<void> {
            await this.runWithToast('big', () => runBigSummary(), {
                success: outcome => (outcome.kind === 'big-done' ? '已更新大总结' : ''),
                failLabel: '大总结失败',
            });
        },
        /** 还原全部（运行中拒绝 toast；成功免弹窗——楼层回来即自证）。 */
        restoreAll(): void {
            const outcome = restoreAllSummaries();
            if (outcome.kind === 'busy') {
                showToast('正在生成总结，无法还原——请先取消或等待完成', 'warning');
                return;
            }
            this.resync();
        },
        /** running 镜像置位/清位单点（自动路径与手动路径共用——写口唯一）。 */
        beginRun(kind: 'small' | 'big'): void {
            this.runningKind = kind;
        },
        endRun(): void {
            this.runningKind = null;
        },
        /**
         * 手动生成的统一收口：置 running 镜像→守卫通过后启动生成→按结果
         * toast→resync（生成落账后的状态行自新触发点）。生成传 thunk 而
         *非已启动的 Promise——实参求值即启动会先于本函数的 runningKind
         * 守卫（现靠 generator 互斥锁兜底，契约不能靠巧合）。skipped
         * reason 是用户向文案逐字 toast；busy/cancelled 静默（UI 已有
         * 生成中形态与取消按钮）。
         */
        async runWithToast(kind: 'small' | 'big', start: () => Promise<SummaryRunOutcome>, format: {
            success: (outcome: SummaryRunOutcome) => string;
            failLabel: string;
        }): Promise<void> {
            if (this.runningKind !== null) return;
            this.beginRun(kind);
            try {
                const outcome = await start();
                if (outcome.kind === 'small-done' || outcome.kind === 'big-done') {
                    const text = format.success(outcome);
                    if (text !== '') showToast(text, 'success');
                    if (outcome.kind === 'small-done' && outcome.bigError !== undefined) {
                        showToast(`大总结失败：${outcome.bigError}`, 'error');
                    }
                } else if (outcome.kind === 'failed') {
                    showToast(`${format.failLabel}：${outcome.message}`, 'error');
                } else if (outcome.kind === 'skipped') {
                    showToast(outcome.reason, 'warning');
                }
            } finally {
                this.endRun();
                this.resync();
            }
        },
    },
});
