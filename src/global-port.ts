/**
 * 全局排障口统一命名空间（__TT_TOOLKIT__）：浏览器 devtools 的唯一入口，
 * 子键按功能域分挂（nav/prompts/debug/storage），各子键自 freeze、根对象
 * 由各安装点按域补挂——安装时序互不依赖（模块求值期与 init 期并存）。
 */

/** 取（必要时建）命名空间根对象；返回值供各域挂自己的子键。 */
export function toolkitGlobalPort(): Record<string, unknown> {
    const g = globalThis as Record<string, unknown>;
    const existing = g.__TT_TOOLKIT__;
    if (existing !== null && typeof existing === 'object') return existing as Record<string, unknown>;
    const root: Record<string, unknown> = {};
    g.__TT_TOOLKIT__ = root;
    return root;
}
