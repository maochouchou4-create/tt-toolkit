/**
 * 宿主 API 错误标签（host 适配层）。
 *
 * 为什么要有这个标签：TauriTavern 宿主在非 quiet 生成失败时，把错误
 * 伪装成一条正常的 AI 回复落地（正文以翻译后的 API Error 标签开头、
 * finish_reason='stop'、消息对象上没有任何结构化错误标志——全仓无
 * is_error 字段），下游只能靠文本前缀识别。标签必须与宿主同源计算
 * （scripts/i18n.js:122 translate，与 Tauri 侧同一张 locale 表）：
 * 硬编码单一 locale 会在其他语言下失配；另留 '[API Error]' 硬编码
 * 兜底（宿主 ai-routes.js:235 同款先例）——同源计算退化时（locale 表
 * 缺 key/未装载则 translate 返回原文）英文形态即兜底形态。
 *
 * 核实记录（D:\code\repos\TauriTavern\src）：
 *   - tauri/main/routes/ai-routes.js:232-240 buildErrorAssistantText——
 *     错误正文一定以 translateApiErrorLabel() 开头；:235 宿主判别式
 *     startsWith(errorLabel) || startsWith('[API Error]')。
 *   - tauri/main/routes/ai-error-presenter.js:27-29
 *     translateApiErrorLabel = `[${translateSillyTavern('API Error', 'API Error')}]`。
 *   - scripts/i18n.js:122 export function translate(text, key = null) {
 */

import { translate as stTranslate } from '@sillytavern/scripts/i18n';

/** 宿主落地错误正文的前缀标签（同源计算，zh-cn 下为 '[API 错误]'）。 */
export function getHostApiErrorLabel(): string {
    return `[${stTranslate('API Error')}]`;
}
