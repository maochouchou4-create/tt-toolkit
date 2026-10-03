// 统一 console 出口：[PW] 前缀与等级单点维护（此前散落的 console 有 5 处漏前缀）。
// src 内禁裸 console——由 scripts/gate-output.mjs 把守；toast 等用户可见文案归 strings.js，
// 本模块只管诊断通道。
const PREFIX = "[PW]";
export const log = (...args) => console.log(PREFIX, ...args);
export const warn = (...args) => console.warn(PREFIX, ...args);
export const error = (...args) => console.error(PREFIX, ...args);
