// dev-harness 构建器：ESM 逐文件形态（批 A 起 dist 为多 chunk）——读 dist/
// 全部 .js 产物，逐文件把 @sillytavern 相对路径 import（../ 上溯形态）重写为
// 对 globalThis.__TT_HARNESS__ 的解构，产出 scripts/dev-harness/dist-harness/
// 下同名文件；chunk 间相对 import（./ 形态）原样保留（宿主本就按 ESM 加载
// dist，模块形态保真度更高；import.meta.url 在模块里原生合法，不再替换）。
// node 冒烟 chunk（含 [node-smoke] BOOT DONE 标记）不进 harness：浏览器
// 分支永不执行它，复制过去只是多一份不会加载的死代码。
// 消费契约（stub 面）见同目录 README.md；dist 形态变化时（import 语句
// 增删）本脚本 fail fast，先更新 STUBS 表再复跑。
// 产物须走 HTTP 加载（node scripts/dev-harness/serve.mjs）：ESM 相对路径
// 在 file:// 下会被 CORS 策略拦截，file:// 直开不再支持。
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const root = join(harnessDir, '..', '..');
const distDir = join(root, 'dist');
const outDir = join(harnessDir, 'dist-harness');

const BOOT_DONE_MARK = '[node-smoke] BOOT DONE';
const ENTRY_NAME = 'index.js';

// 外部 import 说明符 basename → __TT_HARNESS__ 键（stubs.js 同表维护）
const STUBS = {
    'events.js': 'events',
    'script.js': 'script',
    'extensions.js': 'extensions',
    'st-context.js': 'st_context',
    'SlashCommand.js': 'slash_command',
    'SlashCommandParser.js': 'slash_command_parser',
    'RossAscends-mods.js': 'ross_ascends_mods',
    'power-user.js': 'power_user',
    'world-info.js': 'world_info',
    'personas.js': 'personas',
    'utils.js': 'utils',
    'i18n.js': 'i18n',
};

const distFiles = readdirSync(distDir).filter(f => f.endsWith('.js')).sort();
if (distFiles.length === 0) {
    throw new Error('dev-harness: dist/ 无 .js 产物——先复跑 pnpm run build');
}

// 冒烟面必须恰一个 chunk 承载且入口零标记：入口静态拉回冒烟面＝分块失效
//（浏览器加载面混回测试代码），标记 chunk 缺席或重复＝产物形状漂移
const markerFiles = distFiles.filter(f => readFileSync(join(distDir, f), 'utf8').includes(BOOT_DONE_MARK));
if (markerFiles.length !== 1) {
    throw new Error(`dev-harness: 含 BOOT DONE 标记的产物应恰 1 个，实得 ${markerFiles.length}（${markerFiles.join('、') || '无'}）——分块形态变化，先查 pnpm run build 产物`);
}
if (readFileSync(join(distDir, ENTRY_NAME), 'utf8').includes(BOOT_DONE_MARK)) {
    throw new Error('dev-harness: 入口 index.js 自含 BOOT DONE 标记——冒烟面被静态拉回入口图，分块失效');
}

// 全量重生成：dist 形态收缩时陈旧 chunk 文件不得残留（残件＝验证旧代码）
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let hits = 0;
let written = 0;
for (const name of distFiles) {
    if (markerFiles.includes(name)) continue;
    const source = readFileSync(join(distDir, name), 'utf8');
    const rewritten = source.replace(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)";/g, (whole, names, spec) => {
        // chunk 间相对 import 原样保留（ESM 形态不分块不拼接）
        if (!spec.startsWith('../')) return whole;
        const base = spec.split('/').pop();
        const key = STUBS[base];
        if (!key) {
            throw new Error(`dev-harness: 未知外部 import 说明符（先在 STUBS 登记）: ${spec}（${name}）`);
        }
        hits += 1;
        // `event_types as rn` → `event_types: rn`（import 改名到解构改名的语法转换）
        const destructured = names
            .split(',')
            .map(n => n.trim())
            .filter(Boolean)
            .map(n => n.replace(/\s+as\s+/, ': '))
            .join(', ');
        return `const { ${destructured} } = globalThis.__TT_HARNESS__.${key};`;
    });
    writeFileSync(join(outDir, name), `// 本文件由 build.mjs 生成（源＝dist/${name}）——勿手改\n${rewritten}`);
    written += 1;
}
if (hits === 0) {
    throw new Error('dev-harness: dist 产物未匹配到任何外部 import——dist 形态变化，先复跑 pnpm run build');
}

console.log(`dev-harness: dist-harness/ 已生成（${written} 个文件，重写 ${hits} 条外部 import；跳过冒烟 chunk ${markerFiles[0]}）`);
