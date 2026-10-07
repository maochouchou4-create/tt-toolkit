/**
 * summary 模块入口（node 冒烟路径用：默认设置落盘＋冒烟接线，不挂 DOM）。
 * 浏览器路径的事件接线与「总结」tab 归宿主接线批（见实施方案批 3）。
 */
import { readSummarySettings, writeSummarySettings } from './settings';

/**
 * 最小初始化：当前设置经 normalize 读出后写回——缺席键回填默认值落盘
 * （幂等；既有合法值原样保真），保证后续读方面永远是归一化形状。
 */
export function initSummaryMinimal(): void {
    writeSummarySettings(readSummarySettings());
}

export { runSummarySmoke } from './smoke';
