#!/usr/bin/env node
/**
 * dist 外置说明符断言（方案 §5，每批构建后必跑）。
 *
 * 职责：
 *   1. 从 vite.config.ts 机读 @sillytavern 说明符的相对上溯级数（单一
 *      真相源，不在脚本里复写数字）；
 *   2. 扫 src 树（.ts/.vue/.js/.mjs/.tsx/.jsx）提取全部 @sillytavern
 *      导入（清单从源码机生成，禁人工维护）：出现在 src/host/ 之外
 *      → exit 1（适配层隔离约束）；host 内每条按「无后缀 + resolver
 *      补 .js」规则折算为期望的 dist 相对说明符。导入形态覆盖三种：
 *      from '…'（含 re-export）、动态 import('…')、裸副作用 import '…'；
 *   3. 扫 dist/index.js 提取实际外置说明符（同样三形态）及各自 ../
 *      级数；
 *   4. 逐条对照（双向差集 + 逐条级数断言，不按总数——总数断言锁不住
 *      单条错配）。任一失败 → exit 1。
 *
 * 注：块注释内不得出现「斜杠+星」闭合序列，涉及 @sillytavern 与
 * glob 的措辞一律加空格隔开。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = join(ROOT, 'src');
const DIST_ENTRY = join(ROOT, 'dist', 'index.js');
const VITE_CONFIG = join(ROOT, 'vite.config.ts');

// ---- 1. 机读上溯级数 ----------------------------------------------------

function readUplevels() {
    const configText = readFileSync(VITE_CONFIG, 'utf8');
    const match = configText.match(/SILLYTAVERN_UPLEVELS\s*=\s*(\d+)/);
    if (!match) {
        fail(`vite.config.ts 中找不到 SILLYTAVERN_UPLEVELS 常量（级数单一真相源被破坏）`);
    }
    return Number(match[1]);
}

// ---- 2. 源码扫描：@sillytavern 导入清单（机生成） ------------------------

function walkFiles(dir, exts, acc = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            walkFiles(full, exts, acc);
        } else if (exts.some(ext => name.endsWith(ext))) {
            acc.push(full);
        }
    }
    return acc;
}

// 三种导入形态：from '…'（含 re-export）、动态 import('…')、裸副作用
// import '…'。捕获组＝@sillytavern/ 之后的说明符尾部。
const SPECIFIER_FORMS = [
    /from\s*['"]@sillytavern\/([^'"]+)['"]/g,
    /import\s*\(\s*['"]@sillytavern\/([^'"]+)['"]\s*\)/g,
    /import\s*['"]@sillytavern\/([^'"]+)['"]/g,
];

// 剥离注释再匹配：import '…' / import('…') 形态会命中注释里的示例
// 文字（如 host 文件头写的 import '@sillytavern/…'）——注释不是导入。
// 线注释的负向断言保护字符串里的协议斜杠（https: 等）。
function stripComments(text) {
    return text
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * @returns {{ file: string, specifier: string }[]} 全部 @sillytavern 导入
 */
function collectSourceImports() {
    const files = walkFiles(SRC_DIR, ['.ts', '.tsx', '.jsx', '.js', '.mjs', '.vue']);
    const imports = [];
    for (const file of files) {
        const text = stripComments(readFileSync(file, 'utf8'));
        for (const re of SPECIFIER_FORMS) {
            re.lastIndex = 0;
            for (const match of text.matchAll(re)) {
                imports.push({ file: relative(ROOT, file).replaceAll('\\', '/'), specifier: match[1] });
            }
        }
    }
    return imports;
}

// ---- 3. dist 扫描：外置说明符 -------------------------------------------

// dist 同三形态（产物经 esbuild 压缩，import 与引号间可能无空白）
const DIST_SPECIFIER_FORMS = [
    /from\s*['"](\.\.\/[^'"]+)['"]/g,
    /import\s*\(\s*['"](\.\.\/[^'"]+)['"]\s*\)/g,
    /import\s*['"](\.\.\/[^'"]+)['"]/g,
];

function collectDistSpecifiers(text) {
    const specifiers = new Set();
    for (const re of DIST_SPECIFIER_FORMS) {
        re.lastIndex = 0;
        for (const match of text.matchAll(re)) {
            specifiers.add(match[1]);
        }
    }
    return specifiers;
}

// ---- 4. 对照与输出 -------------------------------------------------------

const problems = [];

function fail(message) {
    console.error(`[check-imports] FAIL: ${message}`);
    process.exit(1);
}

const uplevels = readUplevels();
const prefix = '../'.repeat(uplevels);
const sourceImports = collectSourceImports();
const expected = new Set();
let hostImportCount = 0;

for (const { file, specifier } of sourceImports) {
    if (!file.startsWith('src/host/')) {
        problems.push(`隔离违规：${file} 导入了 @sillytavern/${specifier}（@sillytavern/* 只允许出现在 src/host/）`);
        continue;
    }
    // 源码统一无后缀形态 + resolver 无条件补 .js（vite.config.ts）
    const distSpecifier = `${prefix}${specifier}.js`;
    expected.add(distSpecifier);
    hostImportCount++;
}

let distEntryText;
try {
    distEntryText = readFileSync(DIST_ENTRY, 'utf8');
} catch {
    fail(`dist/index.js 不存在——先跑 pnpm build`);
}

const actual = collectDistSpecifiers(distEntryText);

// 逐条级数断言（在 expected 精确串对照之外独立数级数，防 prefix 规则
// 本身拼错导致「集合相等但级数错误」的假阴性之外的路径形态问题）
const uplevelCount = s => (s.match(/\.\.\//g) ?? []).length;
for (const spec of actual) {
    if (uplevelCount(spec) !== uplevels) {
        problems.push(`级数错误：dist 说明符 ${spec} 为 ${uplevelCount(spec)} 级上溯，期望 ${uplevels} 级`);
    }
}

// 双向差集
for (const spec of expected) {
    if (!actual.has(spec)) {
        problems.push(`清单漂移：src/host 期望的外置说明符 ${spec} 未出现在 dist/index.js`);
    }
}
for (const spec of actual) {
    if (!expected.has(spec)) {
        problems.push(`多余说明符：dist/index.js 的 ${spec} 没有对应 src/host 导入`);
    }
}

if (problems.length > 0) {
    for (const p of problems) console.error(`[check-imports] FAIL: ${p}`);
    process.exit(1);
}

console.log(`[check-imports] OK：上溯 ${uplevels} 级；src/host 导入 ${hostImportCount} 条 @sillytavern 说明符（${[...expected].length} 条唯一），dist 产物逐条一致。`);
