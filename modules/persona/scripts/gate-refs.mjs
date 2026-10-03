// 断言符号引用形态。absent＝文件集内不得出现裸引用（obj.sym 点号引用与 $ 前缀标识符不计；
// 注释内命中也计违例，选符号时先核对注释）。absentDecl＝不得出现顶层声明形态
//（含 export 前缀的 export let/const/var/function），供「对象属性键合法、旧声明必须消失」的场景。
// present＝文件集内每个文件都至少一处裸引用。count＝每个文件的裸引用数落在 [min,max] 区间
//（供「恰剩 1 处＝对象字面量键」这类精确形态断言）。sym 为标识符或点号路径（正则元字符自动转义）。
// 用法: node scripts/gate-refs.mjs <absent|absentDecl|present> <symbol> <file...>
//       node scripts/gate-refs.mjs count <symbol> <min> <max> <file...>              exit 0=绿
import { readFileSync } from "node:fs";

const [, , mode, sym, ...rest] = process.argv;
let files = rest;
let min = 0;
let max = 0;
if (mode === "count") {
    min = Number(rest[0]);
    max = Number(rest[1]);
    files = rest.slice(2);
}
if (!["absent", "absentDecl", "present", "count"].includes(mode) || !sym || files.length === 0
    || (mode === "count" && (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || min > max))) {
    console.error("用法: node gate-refs.mjs <absent|absentDecl|present> <symbol> <file...>"
        + " | count <symbol> <min> <max> <file...>"); process.exit(2);
}
const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hits = [];
for (const f of files) {
    const src = readFileSync(f, "utf8");
    let bad;
    if (mode === "absentDecl") bad = new RegExp("^(?:export\\s+)?(?:let|const|var|function|async function)\\s+" + esc + "\\b", "m").test(src);
    else {
        const n = (src.match(new RegExp("(^|[^.\\w$])" + esc + "\\b", "g")) || []).length;
        bad = mode === "absent" ? n > 0 : mode === "present" ? n === 0 : n < min || n > max;
    }
    if (bad) hits.push(f);
}
if (hits.length) { console.error("gate-refs " + mode + " " + sym + " 违例: " + hits.join(", ")); process.exit(1); }
console.log("gate-refs " + mode + " " + sym + " 通过");
