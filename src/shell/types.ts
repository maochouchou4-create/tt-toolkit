/**
 * tab 描述符契约（方案 §2.1，沿批2 经验）：
 *   - tabTitle：tab 条显示名；
 *   - mount(container)：首次激活时把内容渲染进容器（每 tab 一个专属
 *     容器，壳持有；实现可用任意技术——本仓统一 Vue createApp + 共享
 *     pinia 实例）；
 *   - onActivate()：已挂载的 tab 再次被激活（容器保持挂载、仅切换
 *     可见性，编辑态跨 tab 切换不丢）。
 */
export interface ShellTab {
    id: string;
    tabTitle: string;
    mount(container: HTMLElement): void;
    onActivate?(): void;
}
