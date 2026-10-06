/**
 * 跨层共享常量（host 适配层之上的最小集合——shell 注册与 nav QR 建键
 * 共用的命令名，放在任一消费方都会造成另一侧反向依赖）。
 */

/**
 * 工具箱入口斜令名——单一事实源：shell 负责注册、nav QR「工具箱」按钮
 * 的 message 指向它。命令名字面量只允许出现这一处，防双侧各自硬编码
 * 漂移静默断链。
 */
export const TOOLBOX_COMMAND = 'tt-toolbox';
