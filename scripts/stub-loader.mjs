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
    'script.js': [
        'chat_metadata',
        'characters',
        'saveSettingsDebounced',
        'this_chid',
        'sendTextareaMessage',
        'substituteParams',
        'getRequestHeaders',
        'extension_prompts',
        'default_user_avatar',
    ],
    'scripts/extensions.js': ['extension_settings'],
    'scripts/events.js': ['eventSource', 'event_types'],
    'scripts/RossAscends-mods.js': ['dragElement'],
    'scripts/power-user.js': ['power_user'],
    // personas 写回通道（host/personas.ts 导入面）＋世界书写侧
    // （host/worldinfo.ts）＋findPersona（utils）
    'scripts/world-info.js': [
        'getWorldInfoPrompt',
        'loadWorldInfo',
        'createWorldInfoEntry',
        'saveWorldInfo',
        'reloadEditor',
    ],
    'scripts/personas.js': ['getUserAvatars', 'initPersona', 'setUserAvatar', 'user_avatar'],
    'scripts/utils.js': ['findPersona'],
    'scripts/slash-commands/SlashCommandParser.js': ['SlashCommandParser'],
    'scripts/slash-commands/SlashCommand.js': ['SlashCommand'],
    'scripts/st-context.js': ['getContext'],
};

// 相对上溯形态的 @sillytavern 外置说明符（级数不限——check-imports.mjs
// 已对级数做精确断言，这里只做「拦截重定向」）
const EXTERNAL_PREFIX_RE = /^(?:\.\.\/)+(script\.js|scripts\/.+)$/;

// 宿主三者均 export let（script.js:670/675/775）——存根同走活绑定＋
// setter 闭包（测试环境与宿主 let 语义同构）；setter 同步写回全局字段
// ——只改模块绑定会让直读 __TT_SMOKE_STUBS__ 字段的既有断言读到陈旧值
// ＝双真相源。其余名字（对象单例/函数）维持 const 引用快照（对原地改
// 单例无害）。
const LIVE_LET_NAMES = new Set(['this_chid', 'chat_metadata', 'characters']);

function setterName(name) {
    return 'set' + name.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('');
}

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
            if (LIVE_LET_NAMES.has(name)) {
                lines.push(`export let ${name} = globalThis.__TT_SMOKE_STUBS__.${name};`);
                lines.push(`globalThis.__TT_SMOKE_STUBS__.${setterName(name)} = v => { ${name} = v; globalThis.__TT_SMOKE_STUBS__.${name} = v; };`);
            } else {
                lines.push(`export const ${name} = globalThis.__TT_SMOKE_STUBS__.${name};`);
            }
        }
        return { format: 'module', shortCircuit: true, source: lines.join('\n') };
    }
    return nextLoad(url, context);
}
