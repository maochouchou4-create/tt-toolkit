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
    TOAST_PREFILL_UNSUPPORTED: '已记住该端点不支持续写（prefill），下次起直接不带起手词；可在 API 页复位。',
    TOAST_NO_ENDPOINT: '未配置人设生成模型——到「API」页「任务模型」卡配置后再试',
    TOAST_NO_LAST_REQUEST: '未找到上一次的生成需求',
    TOAST_REROLLED: '已重新生成',
    TOAST_CANCELLED: '已取消生成',
    TOAST_EMPTY_RESULT: '内容为空',

    /**
     * 覆盖写回的确认文案：宿主正文偏离我方上次同步的快照时弹。
     *
     * 逐字档（改字即改语义——用户靠这段话判断「覆盖」会丢什么），且必须
     * 说清两种可能来源：在 TT 里直接改过、换了人设卡。
     */
    CONFIRM_OVERWRITE_HOST: '宿主侧的人设在生成后被修改过（可能你在 TT 里直接改过，或换了卡）。继续覆盖会丢失那些修改。仍要覆盖吗？',

    /**
     * 复核简报四态：与 persona 其余文案同住一处（同一个 tab 的文案分两家，
     * 改文案的人必然只翻到其中一家）。
     *
     * 它渲染在结果框正下方的一行里，**不并进结果框**：结果框经 upsertPersona
     * 进宿主 persona_description、经 inject_persona 进此后每一轮对话，一行 UI
     * 文案混进去就是每轮提示词里都漂着它。
     *
     * `FAILURE_REASON` 与四态同组：它是 FAILED 那句里的原因槽，值域恰三项
     * （模型原始报错进不来），逻辑层的失败原因类型直接从它派生——类型即白名单。
     */
    REVIEW_BRIEF: {
        /** 已改写：两处同一个数（重复对数＝改写叶数），叶名按模型给出的顺序逐个列出。 */
        REWRITTEN: (count: number, keys: string) => `模型复核：发现 ${count} 处重复，已改写 ${count} 个字段 —— ${keys}`,
        NONE: '模型复核：未发现重复',
        FAILED: (reason: string) => `模型复核：没能跑完，已保留上一版结果 —— ${reason}`,
        /** 未进复核（结果框为空／还没生成过）——与「跑了没发现」必须分得开。 */
        NOT_RUN: '模型复核：未运行',
        FAILURE_REASON: {
            EMPTY: '响应为空',
            UNUSABLE: '解析不了复核结果',
            REQUEST: '请求失败',
        },
    },
} as const;
