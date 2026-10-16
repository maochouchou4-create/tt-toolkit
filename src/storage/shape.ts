/**
 * 存储域形状守卫。
 *
 * 域键的值来自宿主可变单例与历史存档，形状不保证是普通对象（可能缺席、
 * 可能是数组、可能是旧结构）——读面统一先经此收窄，再由各子域自己的
 * normalize 决定缺省形态。守卫单点在此，域读取面、退役清理面与排障面共用
 * 同一判据（此前同层三份抄本，改一次判据要改三处，迟早会漏改一处）。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
