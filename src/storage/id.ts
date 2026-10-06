/**
 * 运行时唯一 id 生成：端点表新建/迁移、走向预设、存储冒烟 token 共用。
 * 时间基数（36 进制）＋随机尾保证同毫秒多调用不撞；前缀给出处可读性
 * （存量 id 均为「前缀-时间-随机」三段形，存储键契约不受影响）。
 */
export function newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
