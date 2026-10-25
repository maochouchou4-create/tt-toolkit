// dist → dist-harness 的转换单源：build.mjs（生成 dist-harness/）与
// scripts/smoke.mjs（产物漂移门）共用同一份实现——漂移门的判据是「现 dist
// 过一遍本转换＝仓内 dist-harness 逐字一致」，两处各写一份转换就变成自己
// 测自己。外部 import 说明符 → __TT_HARNESS__ 键的对照表也在此（stubs.js
// 与本表同步维护，消费契约见同目录 README.md）。

/** 外部 import 说明符 basename → __TT_HARNESS__ 键（stubs.js 同表维护）。 */
export const STUBS = {
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

/** dist-harness 产物固定头（生成标记＝勿手改警示）。 */
export const HARNESS_FILE_HEADER = name => `// 本文件由 build.mjs 生成（源＝dist/${name}）——勿手改\n`;

/**
 * 单文件转换：@sillytavern 相对路径 import（../ 上溯形态）重写为
 * globalThis.__TT_HARNESS__ 解构；chunk 间相对 import（./ 形态）原样保留。
 * 未知说明符抛错（先在 STUBS 登记）——build.mjs 直跑即 fail fast，
 * smoke.mjs 漂移门捕获后计入失败清单。
 */
export function transformDistFile(source, name) {
    let hits = 0;
    const code = source.replace(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)";/g, (whole, names, spec) => {
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
    return { code, hits };
}
