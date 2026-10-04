/**
 * 选项生成默认模板（唯一模板——m03359 拍板砍配置集，单套即真相源；
 * 方案 §0 病因判定：fork 出厂模板是上游猫娘 RP 特化演化，文本不搬不抄，
 * 按 §2.3 制版原则为「通用 RP + flash 级模型」重写）。
 *
 * 制版原则落点：
 *   - 结构化分段标签：注入模块由引擎包裹 <persona>/<character>/…
 *     分段标签，文本模块自身保持短小；
 *   - 指令条目化短而刚性：每条规则一行一事，不写长段落；
 *   - 正向示例＋few-shot 为主：few_shot 模块给覆盖真人反应类型的完整
 *     示例（可关），各规则写「要做什么」而非「不许做什么」；
 *   - 负向禁令最少化：仅保留第三人称叙述口径这一条结构性约束（选项
 *     视角失控会导致输出系统性跑偏，属结构约束而非风格禁令）；
 *   - 池规则并入（m03359 整合轮）：旧「池级反 OOC 规则」不再独立注入，
 *     要点去重后写进 core_rules 第 2 条——同一约束每请求只出现一份；
 *   - 占位符：{{count}}/{{min_chars}}/{{max_chars}}/{{user}}/{{char}}。
 */
import type { PromptConfig } from './types';

/** 模块 order 分段：注入类 20-100，规则/格式类 110-140（生成指令收尾）。 */
export function createDefaultPromptConfig(): PromptConfig {
    return {
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
                content: '你是沉浸式角色扮演的主持人，负责为用户（{{user}}）与角色（{{char}}）的对话提供下一步的行动选项。',
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
                // 模块本体默认参与管线；「默认关」由配置侧承载（无勾选槽位/
                // 柏宝书开关关＝不注入，见 external.ts／store.ts）——单步生效，
                // 不做「模块开关＋内容勾选」双重门
                kind: 'inject',
                id: 'inject_external_slot',
                name: '外部注入搬运',
                role: 'system',
                order: 94,
                enabled: true,
                source: 'external_slot',
            },
            {
                // 同上：默认关由 store 的 externalInjections.baibai 开关承载
                kind: 'inject',
                id: 'inject_baibai',
                name: '柏宝书摘要',
                role: 'system',
                order: 96,
                enabled: true,
                source: 'baibai',
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
                // 批C：池条目注入。默认参与管线——空池/无绑定自然跳过（trace
                // 留痕说明原因），不是「默认关」：有池数据就该在场。
                // 池规则模块已删（m03359）：反 OOC 要点并入 core_rules
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
                content: [
                    '<example>',
                    '输出示例（仅演示格式与写法，内容与当前剧情无关；三种视角混合：{{user}} 的行动、{{char}} 的主动行为与反应、场景层面的事件。留意其中「真人感」的写法——迟疑、岔开、回避、小心思，而不是每条都直奔主题）：',
                    '{',
                    '  "options": [',
                    '    {"title": "询问昨夜去向", "content": "{{user}} 压下心头的疑惑，放缓语气问道：「昨天夜里，你到底去了哪里？」"},',
                    '    {"title": "岔开话题", "content": "{{user}} 注意到她握着杯沿的手收紧了一瞬，却只是笑着把话头带开：「这酒不错——你从哪儿淘来的？」"},',
                    '    {"title": "沉默回避", "content": "她垂下眼睛，用小勺慢慢搅着咖啡，好一会儿才轻声说：「……让我再想想，怎么回答你。」"},',
                    '    {"title": "应激收声", "content": "楼道里突然传来脚步声，{{char}} 立刻噤声，一把攥住 {{user}} 的手腕，把两人拉进门后的阴影里。"},',
                    '    {"title": "反客为主", "content": "{{char}} 忽然放下茶杯，直视 {{user}} 的眼睛：「在问别人之前，先解释一下你袖口上沾的口红印吧。」"},',
                    '    {"title": "幽默化解", "content": "{{user}} 摸着后脑勺笑出了声：「行吧，这回算我栽了——但下一题，换我出。」"},',
                    '    {"title": "骤然断电", "content": "整层楼的灯骤然熄灭，黑暗中传来玻璃碎裂声，电梯井的方向有人惊呼了一句什么。"}',
                    '  ]',
                    '}',
                    '</example>',
                ].join('\n'),
            },
            {
                kind: 'text',
                id: 'core_rules',
                name: '写作规则',
                role: 'system',
                order: 120,
                enabled: true,
                content: [
                    '<rules>',
                    '写作规则：',
                    '1. 每条选项是一个具体的剧情推进动作：可以是 {{user}} 的行动，也可以是其他角色（如 {{char}}）的主动行为或反应，还可以是场景层面的事件发展。',
                    '2. 每条选项由其主体按自身人设发起：说什么、做什么、图什么，都要从这个角色本来会的方式里来，不得出现该角色不会说的话、不会做的事。仅当情境压力极端（生死、重大转折、情绪失控）时允许小幅越线，且核心性格与说话方式不变形。',
                    '3. 反应要像真人：可以迟疑、回避、答非所问、带一点小心思，不必每条都直奔主题。',
                    '4. 全部以第三人称叙述书写：用角色名或他／她指代，不用「你」。优先使用场景内已有的对象、人物与线索。',
                    '5. 恰好 {{count}} 条，各条角度错开（如：推进对话、试探、采取行动、暂且回避）。',
                    '6. 每条正文 {{min_chars}}～{{max_chars}} 字，写出具体的动作与言语，可含一句直接对白。',
                    '</rules>',
                ].join('\n'),
            },
            {
                kind: 'text',
                id: 'output_format',
                name: '输出契约',
                role: 'system',
                order: 130,
                enabled: true,
                content: [
                    '<format>',
                    '输出一个 JSON 对象，形如 {"options": [...]}，其中 options 是恰好 {{count}} 个元素的数组，每个元素形如：',
                    '{"title": "简短标题（10字内）", "content": "选项正文"}',
                    '只输出这个 JSON 对象，不要输出任何其他内容。',
                    '</format>',
                ].join('\n'),
            },
            {
                kind: 'text',
                id: 'task_instruction',
                name: '生成指令',
                role: 'user',
                order: 140,
                enabled: true,
                content: '请根据以上设定与 <current_scene> 中的当前场景，生成恰好 {{count}} 条可选的推进方向。',
            },
        ],
    };
}
