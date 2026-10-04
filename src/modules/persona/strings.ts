/**
 * PersonaWeaver fork 文案注册表（批D 平移）。
 *
 * MODIFICATIONS（相对上游 fork）：
 * - 砍 PANEL_TITLE/BN_TITLE（callPopup 弹窗入口整体退役，入口改工具箱 tab）。
 * - 其余键原样保留；toast 第一实参仍禁止字符串字面量（文案唯一真源在此）。
 */

/** UI 文案（部分键是函数：插值名/错误信息）。 */
export const TEXT = {
    TOAST_SAVE_SUCCESS: (name: string) => `Persona "${name}" 已保存并覆盖！`,
    TOAST_SAVE_FAIL: (msg: string) => `保存人设失败: ${msg}`,
    TOAST_WI_SUCCESS: (book: string, name: string) => `已写入世界书: ${book} (条目: ${name})`,
    TOAST_WI_FAIL: '当前角色未绑定世界书，无法写入',
    TOAST_WI_WRITE_FAIL: '写入世界书失败：',
    TOAST_LOAD_CURRENT: '已读取当前内容',
    TOAST_QUOTA_ERROR: '浏览器存储空间不足 (Quota Exceeded)，请清理浏览器存储。',
    TOAST_NO_CHANGES: '没有检测到内容变化',
    TOAST_PREFILL_RETRY: 'API 返回 400 错误 (可能是 Gemini 等模型不支持 Prefill)，正在尝试兼容模式重试...',
    TOAST_PROFILE_SAVED: (name: string) => `已保存为配置：${name}（后续修改自动保存）`,
    TOAST_SELECT_PROFILE: '请先选择一个已保存的配置',
    TOAST_PROFILE_DELETED: '已删除配置',
    TOAST_NOTHING_TO_COPY: '没有内容可复制',
    TOAST_COPIED: '人设已复制',
    TOAST_REFINE_EMPTY: '请输入润色意见',
    TOAST_REFINE_FAIL: (msg: string) => `润色失败: ${msg}`,
    TOAST_NO_LAST_REQUEST: '未找到上一次的润色要求',
    TOAST_REROLLED: '已重新生成并更新对比！',
    TOAST_REROLL_FAIL: (msg: string) => `重Roll失败: ${msg}`,
    TOAST_APPLIED: '修改已应用',
    TOAST_NO_VALID_CONTENT: '未找到有效内容',
    TOAST_NO_WI_BOOKS: '未找到可用的世界书',
    TOAST_NO_WI_ENTRIES: '世界书中没有找到相关条目',
    TOAST_EMPTY_FOR_SAVE: '内容为空，无法保存',
    TOAST_EMPTY_RESULT: '内容为空',
    TOAST_CONN_OK: '连接成功！',
    TOAST_CONN_FAIL: '请求发送失败',
    TOAST_CONN_STATUS: (status: string | number) => `失败: ${status}`,
    TOAST_MODELS_LOADED: (n: number) => `获取到 ${n} 个模型`,
    TOAST_PINNED: (book: string) => `已固定「${book}」，将在所有角色卡中自动加载`,
    TOAST_UNPINNED: (book: string) => `已取消固定「${book}」`,
    TOAST_RESET_TO_WI: '已重置为世界书原始状态',
} as const;
