/**
 * summary 模块入口。
 * 浏览器路径（initSummary）：事件接线＋自愈＋启动挂槽；node 冒烟路径
 * 用 initSummaryMinimal（默认设置落盘＋冒烟接线，不挂 DOM）。
 */
import { installSummaryAuto } from './auto';
import { readSummarySettings, writeSummarySettings } from './settings';
import { resyncSummarySlot } from './slot';
import { selfHealSummaryState } from './state';

/**
 * 最小初始化：当前设置经 normalize 读出后写回——缺席键回填默认值落盘
 * （幂等；既有合法值原样保真），保证后续读方面永远是归一化形状。
 */
export function initSummaryMinimal(): void {
    writeSummarySettings(readSummarySettings());
}

/**
 * 浏览器初始化（main.ts 引导调用）：事件接线（MESSAGE_RECEIVED 自动
 * 触发＋CHAT_CHANGED 生命周期）→ 自愈 → 启动挂槽（兜 autoload 晚于
 * 扩展就绪：CHAT_CHANGED 不再触发的已加载聊天也能恢复注入）。
 */
export function initSummary(): void {
    initSummaryMinimal();
    installSummaryAuto();
    selfHealSummaryState();
    resyncSummarySlot();
}

export { runSummarySmoke } from './smoke';
