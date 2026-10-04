/**
 * node 冒烟的模块解析存根（scripts/smoke.mjs 经 module.register 挂载）。
 *
 * dist/index.js 的 @sillytavern 外置导入（../../…/script.js 形态相对
 * 说明符）在 node 下无处解析——本 loader 把它们重定向到内存生成的
 * 存根模块。存根导出面与 src/host 实际导入面一一对应（表与 host 各
 * 文件的 import 名单对齐）：dist 若导入了表中不存在的名字，加载立刻
 * TypeError——导入面被冒烟顺手锁定。
 *
 * 存根语义（node 冒烟只验证「dist 可加载 + storage roundtrip + 探测
 * 机制」，不模拟宿主行为）：
 *   - settings 可变单例挂在 globalThis.__TT_SMOKE_STUBS__（roundtrip
 *     在同一对象上写读，链路与宿主同构）；
 *   - save*Debounced：同步 noop；
 *   - eventSource：可订阅的空总线；
 *   - SlashCommandParser：带 commands 表的注册器（探测项可查）。
 */

const STUB_EXPORTS = {
    'script.js': ['chat_metadata', 'characters', 'saveSettingsDebounced', 'this_chid'],
    'scripts/extensions.js': ['extension_settings', 'saveMetadataDebounced', 'cancelDebouncedMetadataSave'],
    'scripts/events.js': ['eventSource', 'event_types'],
    'scripts/slash-commands/SlashCommandParser.js': ['SlashCommandParser'],
    'scripts/slash-commands/SlashCommand.js': ['SlashCommand'],
    'scripts/st-context.js': ['getContext'],
};

// 相对上溯形态的 @sillytavern 外置说明符（级数不限——check-imports.mjs
// 已对级数做精确断言，这里只做「拦截重定向」）
const EXTERNAL_PREFIX_RE = /^(?:\.\.\/)+(script\.js|scripts\/.+)$/;

export async function resolve(specifier, context, nextResolve) {
    const match = specifier.match(EXTERNAL_PREFIX_RE);
    if (match) {
        return { url: `x-stub:${match[1]}`, shortCircuit: true, format: 'module' };
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (url.startsWith('x-stub:')) {
        const tail = url.slice('x-stub:'.length);
        const names = STUB_EXPORTS[tail];
        if (!names) {
            // 导入面漂移：host 改了导入而存根表没跟上（或反之），
            // 冒烟直接失败并指名道姓
            throw new Error(`冒烟存根表缺失 ${tail}——src/host 导入面与 scripts/stub-loader.mjs 需同步`);
        }
        const lines = [`// smoke stub: ${tail}`];
        for (const name of names) {
            lines.push(`export const ${name} = globalThis.__TT_SMOKE_STUBS__.${name};`);
        }
        return { format: 'module', shortCircuit: true, source: lines.join('\n') };
    }
    return nextLoad(url, context);
}
