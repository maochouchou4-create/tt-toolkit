// node:test 宿主装载器，跑法（npm test 或等价命令行）：
//   node --import ./tests/loader.mjs --test ./tests/yaml.test.js ./tests/diff.test.js ./tests/world-info.test.js
// （--import 不带 ./ 前缀按裸包名解析、--test 目录参数不展开——Node v24 Windows 实测，勿改回简写）
// 做两件事：
// 1) 补齐 src 模块顶层代码假设存在的浏览器全局——实测只有 world-info.js 顶层
//    读 localStorage（装载钉选书目到 store），localStorage 内存桩即够，不做完整仿真；
// 2) 经 register 挂 resolve hook（tests/hooks.mjs），把 ST 宿主 specifier 重定向到桩。
import { register } from "node:module";

const storage = new Map();
globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
};
// 模块顶层在浏览器语义下运行，保底给 window 一个全局对象形态
globalThis.window = globalThis;

register(new URL("./hooks.mjs", import.meta.url));
