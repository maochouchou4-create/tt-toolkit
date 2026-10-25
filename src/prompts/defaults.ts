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
 * 数组次序不按 order 排（池条目 order 98 排在剧情走向 100 之后）：行为排序
 * 由引擎按 order 做，数组次序不承载行为，保持出厂形态即可。
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
import type { PromptConfig, TaskKey } from './types';

// 正文侧的对外面（任务头与判据词表）经此转出：消费方认的是 '@/prompts'
// 或 '@/prompts/defaults' 这一个模块名，拆开后它们的 import 面不变。
export {
    PERSONA_CURATOR_TASK_HEAD,
    PERSONA_GEN_TASK_HEAD,
    PROFILE_PLACEHOLDER_VALUES,
} from './default-texts';

/**
 * 三任务默认模板集（引擎唯一配置源，直读代码常量）：模板编辑器已删、
 * 任务键无编辑面，存储镜像已随 tt-slim 批 C 退役——消费方不再经存档
 * 读回，直接取这里的常量。每个模块对象独立成字面量：两套配置不共享
 * 对象身份，谁也不会改到别人的模块。
 */
export const DEFAULT_PROMPT_CONFIGS: Record<TaskKey, PromptConfig> = {
    choice: {
        id: 'default',
        name: '默认',
        modules: [
            {
                kind: 'text',
                id: 'task',
                name: '任务定义',
                role: 'system',
                order: 10,
                enabled: true,
                content: CHOICE_TASK_TEXT,
            },
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
            {
                // 池条目注入：模块本体默认参与管线；槽位内容收集全自动
                // （非空即带，见 sources.ts）：默认开＝有池数据就
                // 在场；空池/无绑定自然跳过（trace 留痕说明原因）
                kind: 'inject',
                id: 'inject_pool_entries',
                name: '池条目',
                role: 'system',
                order: 98,
                enabled: true,
                source: 'pool_entries',
            },
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
        ],
    },
    persona_curator: {
        id: 'default',
        name: '默认',
        modules: [
            // persona 前缀模块：世界书参考（role system）。预设 system 段源已随任务级
            //  预设选择退役——预设影响统一走传输层破限注入（apis/preset-inject）。
            {
                kind: 'inject',
                id: 'inject_persona_wi',
                name: '世界书参考',
                role: 'system',
                order: 20,
                enabled: true,
                source: 'persona_wi',
            },
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
    },
    persona_gen: {
        id: 'default',
        name: '默认',
        modules: [
            {
                kind: 'inject',
                id: 'inject_persona_wi',
                name: '世界书参考',
                role: 'system',
                order: 20,
                enabled: true,
                source: 'persona_wi',
            },
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
    },
};
