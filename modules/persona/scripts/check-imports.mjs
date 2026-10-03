// 校验仓内 ESM 相对导入：目标文件存在＋导入名与目标导出对得上（默认/具名/副作用三类导入）。
// 文本级检查非完整解析器（limitations：字符串字面量里的伪 import、动态 import() 不识别）；
// 最终兜底是酒馆实载冒烟。ST 宿主模块按形态白名单跳过——它不在本仓。
// 用法: node scripts/check-imports.mjs <repoRoot>
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

// 宿主模块（extensions/script 在宿主根、其余在宿主 scripts/ 目录）只在酒馆运行时存在。
// 注意不带 scripts/ 段：src 的 4/5 段上溯已落在宿主 scripts/ 目录内，多写一段＝
// scripts/scripts/ 双段解析必炸（可选段正则会把坏形态一并放行，三道门同此教训）。
const EXTERNAL = /\/(\.\.\/)+(extensions|script|utils|personas|power-user|world-info)\.js$/;
const IMPORT_RE = /import\s+(?:([^'"]*?)\s*from\s*)?['"](\.[^'"]*)['"]/g;
const NAMED_RE = /\{([^}]*)\}/;

function listJs(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(function (e) {
        const p = join(dir, e.name);
        if (e.isDirectory()) return e.name === "node_modules" || e.name === ".git" ? [] : listJs(p);
        return e.name.endsWith(".js") ? [p] : [];
    });
}

function exportNames(file) {
    const names = new Set();
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\s*\*?|class)\s+([\w$]+)/g)) names.add(m[1]);
    // 多声明符形态：export const a = 1, b = 2 —— 逐段取首个标识符
    for (const m of src.matchAll(/export\s*(?:const|let|var)\s+([^;\n]+?)[;\n]/g)) {
        for (const part of m[1].split(",")) {
            const n = /^[\w$]+/.exec(part.trim());
            if (n) names.add(n[0]);
        }
    }
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(",")) { const n = part.split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
    if (/export\s+default\b/.test(src)) names.add("default");
    return names;
}

function checkRepo(root) {
    const problems = [];
    for (const file of listJs(root)) {
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(IMPORT_RE)) {
            const clause = m[1];
            const spec = m[2];
            if (EXTERNAL.test(spec)) continue;
            const target = resolve(dirname(file), spec);
            if (!existsSync(target)) { problems.push(file + ": 导入目标不存在 " + spec); continue; }
            if (clause === undefined) continue; // 副作用导入：只查文件存在
            const names = exportNames(target);
            const braces = NAMED_RE.exec(clause);
            if (braces) {
                for (const part of braces[1].split(",")) {
                    const n = part.split(/\s+as\s+/)[0].trim();
                    if (n && !names.has(n)) problems.push(file + ": 具名导入 { " + n + " } 在 " + spec + " 中无对应 export");
                }
            }
            const head = clause.replace(NAMED_RE, "").trim();
            if (/^[\w$]+/.test(head) && !names.has("default")) {
                problems.push(file + ": 默认导入在 " + spec + " 中无 export default");
            }
        }
    }
    return problems;
}

const problems = checkRepo(resolve(process.argv[2] || "."));
if (problems.length) { console.error("check-imports 失败:\n" + problems.join("\n")); process.exit(1); }
console.log("check-imports 通过");
