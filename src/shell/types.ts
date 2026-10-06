/**
 * tab 描述符契约：
 *   - tabTitle：tab 条显示名；
 *   - mount(container)：首次激活时把内容渲染进容器（每 tab 一个专属
 *     容器，壳持有；实现可用任意技术——本仓统一 Vue createApp + 共享
 *     pinia 实例）；
 *   - onActivate()：每次激活都调用——含首次 mount 完成后的那次激活
 *     （tab 需要刷新「挂载后外部又变了」的数据时在此刷新；编辑态跨
 *     tab 切换不丢由容器保持挂载保证，与 onActivate 无关）。
 */
export interface ShellTab {
    id: string;
    tabTitle: string;
    mount(container: HTMLElement): void;
    onActivate?(): void;
}
