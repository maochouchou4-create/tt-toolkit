// HTML 转义单一事实源：任何插值进模板串的用户内容必经此函数，防注入与结构破版。
export const escapeHtml = (s) => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
