/**
 * PersonaWeaver fork 文案注册表。
 *
 * MODIFICATIONS（相对上游 fork）：
 * - 砍 PANEL_TITLE/BN_TITLE（callPopup 弹窗入口整体退役，入口改工具箱 tab）。
 * - 已退休特性的文案键随批删除，不留死键；toast 第一实参仍禁止
 *   字符串字面量（文案唯一真源在此）。
 */

/** UI 文案（部分键是函数：插值名/错误信息）。 */
export const TEXT = {
    TOAST_SAVE_SUCCESS: (name: string) => `Persona "${name}" 已保存并覆盖！`,
    TOAST_SAVE_FAIL: (msg: string) => `保存人设失败: ${msg}`,
    TOAST_PREFILL_RETRY: 'API 返回 400 错误 (可能是 Gemini 等模型不支持 Prefill)，正在尝试兼容模式重试...',
    TOAST_NO_ENDPOINT: '未配置端点——到「API」页添加并选择后再试',
    TOAST_NO_LAST_REQUEST: '未找到上一次的生成需求',
    TOAST_REROLLED: '已重新生成',
    TOAST_CANCELLED: '已取消生成',
    TOAST_EMPTY_RESULT: '内容为空',
} as const;
