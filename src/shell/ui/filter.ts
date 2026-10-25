/**
 * 选项匹配单点谓词（大小写不敏感 substring）。
 * TTCombobox 的候选过滤与 ApiTab 的模型清单勾选列表同源消费——同一匹配
 * 语义两处手写是口径分裂种子（单源先例：REASONING_EFFORTS 枚举住守卫旁）。
 */
export function matchesOption(option: string, needle: string): boolean {
    return option.toLowerCase().includes(needle.toLowerCase());
}
