/**
 * 默认模板的模块装配（三任务：choice 选项生成＋persona 两段——策展/填充）。
 * 模板正文与目录派生原语在 default-texts.ts。
 *
 * 这里只回答「哪些模块、什么 order、启不启用」：正文改版要逐字斟酌，装配
 * 改动是拖块调序，两件事混在一处时，改装配要在一屏提示词里找落点，改正文
 * 又容易顺手碰走 order。
 *
 * order 分段：注入类 10-100（任务定义 10 → 人设 20 … 剧情走向 100），
 * 规则/格式类 110-140（示例 → 写作规则 → 输出契约 → 生成指令收尾）。
 * 数组次序不按 order 排（池条目 order 98 排在剧情走向 100 之后）：数组次序
 * 是出厂快照的字节形态的一部分，动它等于动存量档的识别面。
 */
import {
    CHOICE_CORE_RULES_TEXT,
    CHOICE_FEW_SHOT_TEXT,
    CHOICE_OUTPUT_FORMAT_TEXT,
    CHOICE_TASK_INSTRUCTION_TEXT,
    CHOICE_TASK_TEXT,
    PERSONA_CURATOR_PROMPT,
    PERSONA_GEN_PROMPT,
} from './default-texts';
import type { InjectModule, PromptConfig, TaskKey, TextModule } from './types';

// 正文侧的对外面（任务头与判据词表）经此转出：消费方认的是 '@/prompts'
// 或 '@/prompts/defaults' 这一个模块名，拆开后它们的 import 面不变。
export {
    PERSONA_CURATOR_TASK_HEAD,
    PERSONA_GEN_TASK_HEAD,
    PROFILE_PLACEHOLDER_VALUES,
} from './default-texts';

/**
 * 默认模板版本号：默认模板改版即 bump——storage 层据此识别存量旧默认
 * 快照并整键重建（任务键无编辑面＝不存在用户定制，覆盖无损）。
 */
export const DEFAULTS_VERSION = 21;

/**
 * 池条目注入模块（choice 任务专属）：默认模板与存量档补建共用的唯一
 * 定义。
 *
 * 为什么是模块级常量而不是各写一份字面量：旧档里缺这个模块时要按 source
 * 补建，补建用的那份与出厂模板那份一旦漂移（改了 id／order／name 而只改一
 * 侧），补出来的模块就会带着另一套身份进管线——排序错位或引擎认不出它的
 * 源，而现象只是「池条目不见了」，不报错。默认模板在本文件内（它才是这个
 * 模块的出厂地），storage 侧反向引用它，避免两个文件互成环。
 *
 * 每次使用都展开副本（两份配置不共享对象身份：调用方就地改 modules 数组
 * 时会连累出厂常量）。
 */
export const POOL_ENTRIES_MODULE: InjectModule = {
    kind: 'inject',
    id: 'inject_pool_entries',
    name: '池条目',
    role: 'system',
    // 槽位内容收集全自动（非空即带，见 sources.ts）：默认开＝有池数据就
    // 在场；空池/无绑定自然跳过（trace 留痕说明原因）
    order: 98,
    enabled: true,
    source: 'pool_entries',
};

/** choice 任务定义模块（order 10）：开场定位，正文在 default-texts。 */
const CHOICE_TASK_MODULE: TextModule = {
    kind: 'text',
    id: 'task',
    name: '任务定义',
    role: 'system',
    order: 10,
    enabled: true,
    content: CHOICE_TASK_TEXT,
};

/**
 * choice 注入模块组（order 20-100）：人设、角色三件、世界书三段、聊天历史、
 * 外部槽位与剧情走向。各自 order 是管线里的先后位次，与引擎的 source 面
 * 一一对应（缺一个 source 就少一段注入）。
 */
const CHOICE_INJECT_MODULES: readonly InjectModule[] = [
    {
        kind: 'inject',
        id: 'inject_persona',
        name: '用户人设',
        role: 'system',
        order: 20,
        enabled: true,
        source: 'persona',
    },
    {
        kind: 'inject',
        id: 'inject_char_description',
        name: '角色描述',
        role: 'system',
        order: 30,
        enabled: true,
        source: 'char_description',
    },
    {
        kind: 'inject',
        id: 'inject_char_personality',
        name: '角色性格',
        role: 'system',
        order: 40,
        enabled: true,
        source: 'char_personality',
    },
    {
        kind: 'inject',
        id: 'inject_char_scenario',
        name: '故事背景',
        role: 'system',
        order: 50,
        enabled: true,
        source: 'char_scenario',
    },
    {
        kind: 'inject',
        id: 'inject_wi_before',
        name: '世界书（前）',
        role: 'system',
        order: 60,
        enabled: true,
        source: 'world_info_before',
    },
    {
        kind: 'inject',
        id: 'inject_wi_depth_before',
        name: '世界书（深）',
        role: 'system',
        order: 70,
        enabled: true,
        source: 'wi_depth_before',
    },
    {
        kind: 'inject',
        id: 'inject_chat_history',
        name: '聊天历史',
        role: 'system',
        order: 80,
        enabled: true,
        source: 'chat_history',
    },
    {
        kind: 'inject',
        id: 'inject_wi_depth_after',
        name: '世界书（浅）',
        role: 'system',
        order: 90,
        enabled: true,
        source: 'wi_depth_after',
    },
    {
        kind: 'inject',
        id: 'inject_wi_after',
        name: '世界书（后）',
        role: 'system',
        order: 92,
        enabled: true,
        source: 'world_info_after',
    },
    {
        // 模块本体默认参与管线；槽位内容收集全自动（非空即带，
        // 见 sources.ts）——单步生效，不做「模块开关
        // ＋内容勾选」双重门。默认开＝在场即注入
        kind: 'inject',
        id: 'inject_external_slot',
        name: '外部注入搬运',
        role: 'system',
        order: 94,
        enabled: true,
        source: 'external_slot',
    },
    {
        kind: 'inject',
        id: 'inject_story_direction',
        name: '剧情走向',
        role: 'system',
        order: 100,
        enabled: true,
        source: 'story_direction',
    },
];

/**
 * choice 规则与格式模块组（order 110-140）：示例（可关）→ 写作规则 →
 * 输出契约 → 生成指令（role user 收尾）。
 */
const CHOICE_TEXT_MODULES: readonly TextModule[] = [
    {
        kind: 'text',
        id: 'few_shot',
        name: '示例（可关）',
        role: 'system',
        order: 110,
        enabled: true,
        content: CHOICE_FEW_SHOT_TEXT,
    },
    {
        kind: 'text',
        id: 'core_rules',
        name: '写作规则',
        role: 'system',
        order: 120,
        enabled: true,
        content: CHOICE_CORE_RULES_TEXT,
    },
    {
        kind: 'text',
        id: 'output_format',
        name: '输出契约',
        role: 'system',
        order: 130,
        enabled: true,
        // aim 只服务显示与楼层存档，不随发言外发给主模型——所以它是
        // 输出契约的一个键而不是写作规则里的一条：规则段每轮都要模型
        // 重读并占输出预算，而 aim 对模型的写作行为没有任何要求。
        content: CHOICE_OUTPUT_FORMAT_TEXT,
    },
    {
        kind: 'text',
        id: 'task_instruction',
        name: '生成指令',
        role: 'user',
        order: 140,
        enabled: true,
        content: CHOICE_TASK_INSTRUCTION_TEXT,
    },
];

/** 每次装配都展开模块副本：出厂常量与调用方手里的配置不共享对象身份。 */
function freshModules(): PromptConfig['modules'] {
    return [
        { ...CHOICE_TASK_MODULE },
        ...CHOICE_INJECT_MODULES.map(m => ({ ...m })),
        // 池条目注入：模块本体默认参与管线；池规则模块已删（反 OOC
        // 要点并入 core_rules）——定义与存量档补建共用一份常量
        { ...POOL_ENTRIES_MODULE },
        ...CHOICE_TEXT_MODULES.map(m => ({ ...m })),
    ];
}

/** choice 任务默认配置（恢复默认/读侧补缺共用；输出逐字节＝出厂快照形态）。 */
export function createDefaultPromptConfig(): PromptConfig {
    return {
        id: 'default',
        name: '默认',
        defaultsVersion: DEFAULTS_VERSION,
        modules: freshModules(),
    };
}

/** persona 前缀模块：世界书参考（role system）。预设 system 段源已随任务级
 *  预设选择退役——预设影响统一走传输层破限注入（apis/preset-inject）。 */
function personaPreambleModules() {
    return [
        {
            kind: 'inject' as const,
            id: 'inject_persona_wi',
            name: '世界书参考',
            role: 'system' as const,
            order: 20,
            enabled: true,
            source: 'persona_wi' as const,
        },
    ];
}

/**
 * 按任务键取默认配置（恢复默认/读侧补缺共用）。choice 分支＝
 * createDefaultPromptConfig() 原样（输出逐字节不变——choice smoke
 * 回归红线）；persona 两任务＝前缀注入模块＋fork 指令正文。
 */
export function createTaskDefaultConfig(task: TaskKey): PromptConfig {
    switch (task) {
        case 'choice':
            return createDefaultPromptConfig();
        case 'persona_curator':
            return {
                id: 'default',
                name: '默认',
                defaultsVersion: DEFAULTS_VERSION,
                modules: [
                    ...personaPreambleModules(),
                    {
                        kind: 'text',
                        id: 'curator_prompt',
                        name: '策展指令',
                        role: 'user',
                        order: 30,
                        enabled: true,
                        content: PERSONA_CURATOR_PROMPT,
                    },
                ],
            };
        case 'persona_gen':
            return {
                id: 'default',
                name: '默认',
                defaultsVersion: DEFAULTS_VERSION,
                modules: [
                    ...personaPreambleModules(),
                    {
                        kind: 'text',
                        id: 'persona_gen_prompt',
                        name: '生成指令',
                        role: 'user',
                        order: 30,
                        enabled: true,
                        content: PERSONA_GEN_PROMPT,
                    },
                ],
            };
    }
}
