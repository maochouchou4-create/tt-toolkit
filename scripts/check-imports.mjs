#!/usr/bin/env node
/**
 * dist 外置说明符断言（每批构建后必跑）。
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
 *   5. 宿主 CSS 类黑名单（B.1 验收教训机判）：src/host 之外的 UI 面
 *      （.vue/.ts）禁用宿主布局/图标类——.panelControlBar 在宿主是
 *      position:absolute 的右上图标簇（style.css:879-888），塞进壳头行
 *      会把标题钉到右上角压正文（用户实测「乱飞」根因）；fa-* 字形在
 *      扩展上下文实测不渲染（空 div 零宽）。布局与图标必须自持；
 *      允许的白名单＝根皮肤（drawer-content/flexGap5/scrollY）与
 *      宿主契约类（drag-grabber）。src/host/ 不扫（宿主上下文里造宿主
 *      DOM 是合法的）。注释先剥离再匹配（源码注释常引用这些类名）。
 *   6. 宿主可变绑定活绑定纪律（settings 取用器化配套防复发）：src/host/
 *      内禁止快照转出形态（`export const X = <裸标识符>;`——含 TS 注解、
 *      as 断言；`export const {…}`/`export const […]` 解构快照从严全禁）
 *      与三个宿主 let 名（this_chid/chat_metadata/characters）的 re-export
 *      ——ES 活绑定经 const 转手即取值瞬间冻结。唯一白名单＝
 *      extension_settings（宿主侧 const 单例，只原地改从不换引用）。
 *      残余绕过面（多行 const 中转＋`export { x }` 间接导出）不设防
 *      ——属刻意规避且评审可见。
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

// ---- 5. 宿主 CSS 类黑名单（UI 面布局自持约束） ---------------------------

// 黑名单＝宿主布局语义类＋图标字体类（见文件头职责 5 的理由）。
// 允许项：根皮肤类（drawer-content/flexGap5/scrollY）与宿主契约类
// （drag-grabber）不在黑名单内，自然放行。
const HOST_CLASS_BLACKLIST = new Set([
    'panelControlBar',
    'flex-container',
    'alignItemsBaseline',
    'inline-drawer',
    'fa-solid',
    'fa-fw',
    'fa-circle-xmark',
]);

function collectClassTokens(text) {
    const tokens = [];
    for (const match of text.matchAll(/class="([^"]*)"/g)) {
        tokens.push(...match[1].trim().split(/\s+/).filter(Boolean));
    }
    for (const match of text.matchAll(/className\s*=\s*['"]([^'"]*)['"]/g)) {
        tokens.push(...match[1].trim().split(/\s+/).filter(Boolean));
    }
    return tokens;
}

{
    const files = walkFiles(SRC_DIR, ['.ts', '.tsx', '.js', '.mjs', '.vue'])
        .filter(f => !relative(ROOT, f).replaceAll('\\', '/').startsWith('src/host/'));
    for (const file of files) {
        const text = stripComments(readFileSync(file, 'utf8'));
        for (const token of collectClassTokens(text)) {
            if (HOST_CLASS_BLACKLIST.has(token)) {
                problems.push(
                    `宿主类黑名单：${relative(ROOT, file).replaceAll('\\', '/')} 使用了宿主布局/图标类「${token}」（UI 面布局与图标必须自持，见 check-imports 文件头职责 5）`,
                );
            }
        }
    }
}

// ---- 6. 宿主可变绑定快照转出黑名单（活绑定纪律） --------------------------

// 快照转出形态：初始化器为裸标识符（含 TS 注解与 as 断言链、分号可缺省）
const SNAPSHOT_CONST_RE = /^\s*export\s+const\s+(\w+)(?:\s*:[^=]+)?\s*=\s*[A-Za-z_$][\w$]*(?:\s+as\s+[\w$.<>[\]]+)*\s*;?\s*$/;
// 解构快照：从严全禁（现 host/ 无此形态；撞到合法形态停下上报）
const SNAPSHOT_DESTRUCTURE_RE = /^\s*export\s+const\s+[([{]/;
// 宿主可变名 re-export 黑名单（re-export 转发活绑定但光学上与常量导出
// 无差别，天然引诱消费方快照误用——与快照形态一并禁止）
const LIVE_NAME_REEXPORT_RE = /export\s*\{([^}]*)\}\s*from\s*['"]@sillytavern\/[^'"]+['"]/g;
const LIVE_LET_NAMES = new Set(['this_chid', 'chat_metadata', 'characters']);
// 白名单（逐项依据，扩项须附核实证据）：
// - extension_settings：宿主侧 export const 单例（extensions.js:172），只原地改从不换引用；
// - hostWindow：globalThis 的恒定引用转发（进程内不变，非宿主可变绑定）。
const SNAPSHOT_WHITELIST = new Set(['extension_settings', 'hostWindow']);

function collectSnapshotViolations() {
    const hostFiles = walkFiles(join(SRC_DIR, 'host'), ['.ts']);
    for (const file of hostFiles) {
        const rel = relative(ROOT, file).replaceAll('\\', '/');
        const text = stripComments(readFileSync(file, 'utf8'));
        for (const line of text.split('\n')) {
            const constMatch = line.match(SNAPSHOT_CONST_RE);
            if (constMatch && !SNAPSHOT_WHITELIST.has(constMatch[1])) {
                problems.push(
                    `快照转出黑名单：${rel} 的「export const ${constMatch[1]} = …」——宿主可变绑定须经取用器函数出口（见 host/settings.ts 头注），const 快照转出/re-export 已被活绑定纪律禁止`,
                );
            }
            if (SNAPSHOT_DESTRUCTURE_RE.test(line)) {
                problems.push(
                    `快照转出黑名单：${rel} 出现 export const 解构形态（解构快照从严全禁）——宿主可变绑定须经取用器函数出口`,
                );
            }
        }
        for (const match of text.matchAll(LIVE_NAME_REEXPORT_RE)) {
            // as 两侧都查：本名命中＝按原名走私，别名命中＝换名转出——都是
            // 可变绑定经 re-export 通道离开 host 层的形态
            const names = match[1].split(',').flatMap(s => s.trim().split(/\s+as\s+/).map(p => p.trim()));
            for (const name of names) {
                if (LIVE_LET_NAMES.has(name)) {
                    problems.push(
                        `快照转出黑名单：${rel} re-export 宿主可变名「${name}」——宿主可变绑定须经取用器函数出口（见 host/settings.ts 头注），const 快照转出/re-export 已被活绑定纪律禁止`,
                    );
                }
            }
        }
    }
}

collectSnapshotViolations();

if (problems.length > 0) {
    for (const p of problems) console.error(`[check-imports] FAIL: ${p}`);
    process.exit(1);
}

console.log(`[check-imports] OK：上溯 ${uplevels} 级；src/host 导入 ${hostImportCount} 条 @sillytavern 说明符（${[...expected].length} 条唯一），dist 产物逐条一致；快照转出黑名单（含解构与宿主可变名 re-export，白名单 extension_settings）零命中。`);
