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
 *   7. 源级导入环（Tarjan 强连通分量，见职责 7 的口径说明）：src 树按
 *      import / export-from / 动态 import 三形态建有向图，含环 SCC 即环；
 *      新增环 → exit 1，既有环走 EXEMPT_CYCLES 显式豁免（理由随代码
 *      同行，不另立文档）。并入本门禁而非另立脚本：多一个独立环节＝多
 *      一次被跳过的机会，环检测的价值恰在「必跑」。
 *
 * 注：块注释内不得出现「斜杠+星」闭合序列，涉及 @sillytavern 与
 * glob 的措辞一律加空格隔开。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
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

// ---- 7. 源级导入环（Tarjan 强连通分量） ------------------------------------

const CYCLE_EXTS = ['.ts', '.tsx', '.jsx', '.js', '.mjs', '.vue'];

// 说明符→文件：先按原样，再试常见后缀与目录入口（贴齐本仓 import 惯例）。
const CYCLE_SUFFIXES = ['', '.ts', '.vue', '/index.ts', '/index.vue'];

// 三种导入形态（import / 动态 import / export-from）。注释已在上文剥离——
// 注释里的说明符不是导入边。
const CYCLE_IMPORT_FORMS = [
    /(?:^|[\n;])\s*import\s+(?:type\s+)?(?:[^'"();]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /(?:^|[\n;])\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * 既有环的显式豁免登记（每条带 reason，理由与登记同行）。
 *
 * apis 四文件环的性质：端点表与任务档案互为读写源——删端点或切 provider
 * 要重置该 provider 名下的任务档案（storage → task-profiles），而任务路由
 * 解析又必须回读端点表拿 baseUrl（task-profiles → storage）；client ↔
 * preset-inject 则是出站消息的组装面与传输面互相引用。两侧本就是同一个
 * 「服务商配置」概念的两面，硬断开只能把这份上下文在调用侧搬来搬去，
 * 属 apis 域的独立重构。本门禁守的是「不新增」，不负责改既有结构。
 */
const EXEMPT_CYCLES = [
    {
        files: [
            'src/modules/apis/client.ts',
            'src/modules/apis/preset-inject.ts',
            'src/modules/apis/storage.ts',
            'src/modules/apis/task-profiles.ts',
        ],
        reason: 'apis 域「端点表 ↔ 任务档案」互为读写源（重置档案／回读端点）与 client↔preset-inject 的组装—传输互引同属服务商配置整体；断开须连带改调用点，属 apis 域独立重构。',
    },
];

function resolveModuleFile(base, known) {
    for (const suffix of CYCLE_SUFFIXES) {
        if (known.has(base + suffix)) return base + suffix;
    }
    return null;
}

function resolveCycleTarget(fromFile, specifier, known) {
    if (specifier.startsWith('@/')) return resolveModuleFile(`src/${specifier.slice(2)}`, known);
    if (!specifier.startsWith('.')) return null;
    const dir = posix.dirname(fromFile);
    return resolveModuleFile(dir === '.' ? specifier : posix.join(dir, specifier), known);
}

/** src 树导入有向图（键＝仓库相对路径，值＝去重排序的邻接表）。 */
function buildImportGraph() {
    const files = walkFiles(SRC_DIR, CYCLE_EXTS).filter(f => !f.endsWith('.d.ts'));
    const known = new Set(files.map(f => relative(ROOT, f).replaceAll('\\', '/')));
    const graph = new Map();
    for (const file of files) {
        const from = relative(ROOT, file).replaceAll('\\', '/');
        const text = stripComments(readFileSync(file, 'utf8'));
        const edges = new Set();
        for (const re of CYCLE_IMPORT_FORMS) {
            re.lastIndex = 0;
            for (const match of text.matchAll(re)) {
                const target = resolveCycleTarget(from, match[1], known);
                if (target && target !== from) edges.add(target);
            }
        }
        graph.set(from, [...edges].sort());
    }
    return graph;
}

/**
 * Tarjan 强连通分量（迭代实现：深图不爆栈）。返回全部含环分量——
 * 环即分量大小 >1。自环不成边（模块不得导入自身，es 模块图无此形态），
 * 故不必单列判据。
 */
function findCycles(graph) {
    let counter = 0;
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const cycles = [];
    for (const start of graph.keys()) {
        if (index.has(start)) continue;
        const work = [[start, 0]];
        while (work.length > 0) {
            const [v, pi] = work[work.length - 1];
            if (pi === 0) {
                index.set(v, counter);
                low.set(v, counter);
                counter += 1;
                stack.push(v);
                onStack.add(v);
            }
            const kids = graph.get(v) ?? [];
            let descended = false;
            for (let i = pi; i < kids.length; i += 1) {
                const w = kids[i];
                if (!index.has(w)) {
                    work[work.length - 1][1] = i + 1;
                    work.push([w, 0]);
                    descended = true;
                    break;
                }
                if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
            }
            if (descended) continue;
            if (low.get(v) === index.get(v)) {
                const component = [];
                for (;;) {
                    const w = stack.pop();
                    onStack.delete(w);
                    component.push(w);
                    if (w === v) break;
                }
                if (component.length > 1) cycles.push(component.sort());
            }
            work.pop();
            if (work.length > 0) {
                const parent = work[work.length - 1][0];
                low.set(parent, Math.min(low.get(parent), low.get(v)));
            }
        }
    }
    return cycles;
}

function checkCycles() {
    const cycles = findCycles(buildImportGraph());
    const idOf = files => [...files].sort().join(' | ');
    const unexempt = new Map(cycles.map(c => [idOf(c), c]));
    let exempted = 0;
    for (const entry of EXEMPT_CYCLES) {
        if (unexempt.delete(idOf(entry.files))) {
            exempted += 1;
        } else {
            problems.push(`豁免表漂移：登记的环已不存在（${entry.files.join(' | ')}）——豁免面须随结构同进同退，请从 EXEMPT_CYCLES 删除该条目`);
        }
    }
    for (const files of unexempt.values()) {
        problems.push(`新增源级导入环：${files.join(' | ')}（成环 SCC ${files.length} 个文件）。确属既有结构请登记 EXEMPT_CYCLES 并写明理由，否则先断开环`);
    }
    return { total: cycles.length, exempted };
}

const cycleReport = checkCycles();

if (problems.length > 0) {
    for (const p of problems) console.error(`[check-imports] FAIL: ${p}`);
    process.exit(1);
}

console.log(`[check-imports] OK：上溯 ${uplevels} 级；src/host 导入 ${hostImportCount} 条 @sillytavern 说明符（${[...expected].length} 条唯一），dist 产物逐条一致；快照转出黑名单（含解构与宿主可变名 re-export，白名单 extension_settings）零命中；源级导入环：含环 SCC ${cycleReport.total} 处，其中登记豁免 ${cycleReport.exempted} 处、新增 0 处。`);
