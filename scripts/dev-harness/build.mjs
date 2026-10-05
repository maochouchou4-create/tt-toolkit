// dev-harness 构建器：把 dist/index.js 的全部 @sillytavern 相对路径
// import（批D 后为 11 条）重写为对 globalThis.__TT_HARNESS__ 的解构，
// 产出 app.js——经典脚本形态（无模块 import），浏览器 file:// 直接打开
// index.html 即可加载（ESM 相对路径在 file:// 下会被 CORS 策略拦截）。
// 消费契约（stub 面）见同目录 README.md；dist 形态变化时（import 语句
// 增删）本脚本 fail fast，先更新 STUBS 表再复跑。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distFile = join(root, 'dist', 'index.js');
const outFile = join(root, 'scripts', 'dev-harness', 'app.js');

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
};

const source = readFileSync(distFile, 'utf8');
let hits = 0;
const rewritten = source.replace(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)";/g, (whole, names, spec) => {
    const base = spec.split('/').pop();
    const key = STUBS[base];
    if (!key) {
        throw new Error(`dev-harness: 未知外部 import 说明符（先在 STUBS 登记）: ${spec}`);
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
if (hits === 0) {
    throw new Error('dev-harness: dist/index.js 未匹配到任何外部 import——dist 形态变化，先复跑 pnpm run build');
}

writeFileSync(outFile, `// 本文件由 build.mjs 生成（源＝dist/index.js）——勿手改\n${rewritten}`);
console.log(`dev-harness: app.js 已生成（重写 ${hits} 条外部 import）`);
