// 输出规范门：① log.js 之外禁裸 console；② 禁真空 catch 块（带 why 注释的视为合规）；
// ③ toastr 第一实参禁止字符串字面量（文案必须走 strings.js 的 TEXT.*）。
// 用法: node scripts/gate-output.mjs <repoRoot>    exit 0=绿
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] || ".";
const files = readdirSync(join(root, "src"), { recursive: true })
    .filter((f) => f.endsWith(".js") && f !== "log.js")
    .map((f) => join(root, "src", f));
files.push(join(root, "index.js"));

const problems = [];
for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (/(^|[^.\w$])console\s*\./.test(src)) problems.push(f + ": 裸 console（走 src/log.js）");
    if (/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(src)) problems.push(f + ": 空 catch（记日志或写 why 注释）");
    if (/\btoastr\s*\.\s*\w+\s*\(\s*["'`]/.test(src)) problems.push(f + ": toast 字面量文案（收编 strings.js）");
}
if (problems.length) { console.error("gate-output 失败:\n" + problems.join("\n")); process.exit(1); }
console.log("gate-output 通过");
