/**
 * 任务默认模板（三任务：choice 选项生成＋persona 两段——策展/填充）。
 * choice 部分＝唯一的任务模板（fork 出厂模板是上游猫娘 RP 特化演化，
 * 文本不搬不抄，按「通用 RP + flash 级模型」制版原则重写）；persona
 * 部分＝PersonaWeaver fork 默认提示词原样平移（见文末分节注释）。
 *
 * 制版原则落点：
 *   - 结构化分段标签：注入模块由引擎包裹 <persona>/<character>/…
 *     分段标签，文本模块自身保持短小；
 *   - 指令条目化短而刚性：每条规则一行一事，不写长段落；
 *   - 正向示例＋few-shot 为主：few_shot 模块给覆盖真人反应类型的完整
 *     示例（可关），各规则写「要做什么」而非「不许做什么」；
 *   - 负向禁令最少化：仅保留第三人称叙述口径这一条结构性约束（选项
 *     视角失控会导致输出系统性跑偏，属结构约束而非风格禁令）；
 *   - 池规则并入：旧「池级反 OOC 规则」不再独立注入，
 *     要点去重后写进 core_rules 第 2 条——同一约束每请求只出现一份；
 *   - 占位符：{{count}}/{{min_chars}}/{{max_chars}}/{{user}}/{{char}}。
 */
import type { PromptConfig, TaskKey } from './types';

/**
 * 默认模板版本号：默认模板改版即 bump——storage 层据此识别存量旧默认
 * 快照并整键重建（三任务键无编辑面＝不存在用户定制，覆盖无损）。
 */
export const DEFAULTS_VERSION = 8;

/** 模块 order 分段：注入类 20-100，规则/格式类 110-140（生成指令收尾）。 */
export function createDefaultPromptConfig(): PromptConfig {
    return {
        id: 'default',
        name: '默认',
        defaultsVersion: DEFAULTS_VERSION,
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
                // 模块本体默认参与管线；槽位内容收集全自动（非空即带，
                // 见 external.ts／sources.ts）——单步生效，不做「模块开关
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
                // 同上：在场即注入（STBaiBaiBook 缺席/接口异常＝null → 段
                // 缺席不报错，trace 留痕）
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
                // 池条目注入。默认参与管线——空池/无绑定自然跳过（trace
                // 留痕说明原因），不是「默认关」：有池数据就该在场。
                // 池规则模块已删：反 OOC 要点并入 core_rules
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
                    '2. 每条选项由其主体按自身人设发起：说什么、做什么、图什么，都要从这个角色本来会的方式里来，不得出现该角色不会说的话、不会做的事。仅当情境压力极端（生死、重大转折、情绪失控）时允许小幅越线，且核心性格与说话方式不变形。落笔前自查：这条选项的行动主体是谁？其人设里哪一条支持这个行动？（场景事件类选项自查：事件是否符合当前场景的逻辑。）',
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
                content: '请根据以上设定——尤其 <persona>（用户人设）与 <personality>（角色性格）两段，每条选项的行为方式必须从这两段出发——与 <current_scene> 中的当前场景，生成恰好 {{count}} 条可选的推进方向。',
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// persona 任务默认模板（人设三段管线进统一提示词引擎）。
//
// 正文＝PersonaWeaver fork 默认提示词原样平移（零改动，含占位符键名——
// {{charInfo}}/{{greetings}}/{{template}}/{{input}}/{{userRequirements}} 是
// engine fillPersonaPlaceholders 的组装契约，禁止改名）。fork 原三段
// 消息序列（system 预设 / system 世界书参考 / user 指令）映成模块管线：
// 预设段源已退役（预设影响走传输层破限注入），现＝一个 inject 模块
// （persona_wi，role system）＋一个文本模块（指令正文，role user）；
// assistant prefill 仍由 generation.ts 在组装完成后追加（去 prefill
// 重试需要独立消息数组，不进模板）。
// ---------------------------------------------------------------------------

/** 策展指令（persona_curator 任务）：只产出 schema 键名，不填值。 */
const PERSONA_CURATOR_PROMPT = `[任务：策展人设 schema]
[背景：你要为使用者本人（User 自设）设计一份 YAML 人设 schema（只定键名，值为空）。这份人设将与世界书等素材一同被阅读——使用者始终同时看到这两份文档。]

<source_materials>
{{charInfo}}
</source_materials>

{{userRequirements}}

[原则——按顺序适用]：
1. 补充而非重复：使用者通过世界书已经知道的东西不重复设字段（世界规则、传说、地理、阵营、其他角色的背景）。仅当字段捕捉到 User 特有、且素材未提供的信息时才允许。
2. 只写静态本质：人设是长期稳定的「他是谁」档案——身份、性格、如何呈现。禁止添加承载剧情进展或当前状态的字段（如「现状」「当前处境」）：这些随剧情流动，由世界书与对话本身承担。
3. 模块化选材：从参考模块清单中选适合本次的组合——用户需求为第一输入，世界书与角色卡素材为第二输入。宁缺毋滥：没有素材支撑的模块不选；形态与状态机按素材侧重二选一（外形变化归形态，行为反差归状态机）；顶层块不超过 10 个。
4. 世界风味键名：当世界定义了与 User 相关的机制（如境界、第二性别、义体改造），用该世界的词汇添加键名——每个对扮演重要的机制一个键，不多加。
5. 主角聚焦：这是使用者自己的角色——身份、性格、外貌最重要；社交类块保持轻量，关系细节归世界书。
6. 可演性优先：性格类块优先设「写出来就能演」的字段（情绪反应、说话风格一类），少设只能装标签的抽象特质栏。
7. 整体优先：写一贯的行为倾向与底色，不落到标志性小动作、物件偏好、口头禅粒度——那是表演细节，留给对话现场发挥。
8. 结构纪律：只从参考模块清单选块，不造清单外的自定义大块；世界特有机制（境界/第二性别一类）至多补一个块且 ≤3 叶；各模块叶数即上限，不得自行扩叶。

<reference_modules>
基本信息——年龄/性别/身份（一句话社会角色，不做明暗分层）；3 叶；几乎必选
外貌——整体印象/标志性特征；2 叶；几乎必选
性格——核心矛盾/情绪反应/说话风格；3 叶；几乎必选
状态机——各态：概述＋行为特征＋切换触发；≤4 态；有行为/人格反差时（外形变化归形态）
形态——各形态描写＋切换条件；≤3 态；物理/种族形态变化时
成长弧——过去态/现在态；≤2 叶；有成长史时
能力——每条带限制或代价；≤3 叶；有超常能力设定时
背景——来历/关键经历；≤2 叶；素材有支撑时
目标——一个贯穿性动机；1 叶；有持续追求时
喜恶——喜欢/讨厌；2 叶；常选
NSFW——基本倾向/禁忌；2 叶；用户需求或素材明确指向时
</reference_modules>

[约束]：只输出 YAML 键名，值为空，键名用简体中文。不需要姓名字段。无任何解释。输出单个 \`\`\`yaml 代码块。

[行动]：
现在输出策展好的 YAML schema。`;

/** 人设填充指令（persona_gen 任务）。 */
const PERSONA_GEN_PROMPT = `[任务：生成用户人设]
[目标对象：User——使用者本人的扮演身份]
[背景：本档案是使用者本人（User）的长期人设，供 AI 在整个扮演过程中稳定呈现 User——它定义的是不随剧情改变的「他是谁」与「如何扮演」。下方素材定义了 User 所处的世界与他身边的人——素材中出现的其他人物（无论名字与 User 相近与否）都是 User 的关系对象，档案主体永远是 User 本人。当前处境、关系进展与剧情动态由对话演化，档案不追踪。]

<source_materials>
{{charInfo}}
{{greetings}}
</source_materials>

<target_schema>
{{template}}
</target_schema>

{{input}}

<value_style_examples>
[文风示例——只示范「值写成 2～4 个行为向短标签的叠加算合格」，禁止照搬示例内容；你的值必须出自本对话的素材。]

核心矛盾
  同义堆叠（禁）：冷静自持、从容不迫
  标签叠加（对）：强势；吃软不吃硬；护短
  情境剧场（也禁）：遭人质问吵闹只冷眼俯视并继续做事，直至对方自讨没趣
情绪反应
  同义堆叠（禁）：遇事冷静，不易动怒
  标签叠加（对）：挑衅一律冷处理；遭背叛必清算
  情境剧场（也禁）：被当众拆穿先僵两秒，随后用一句更冷的玩笑找回场子
</value_style_examples>

[要求]：
1. 主体锚定——所有字段写 User 本人；涉及其他人物的字段（来历、背景）以素材给出的关系为准组织，素材未覆盖的人物细节做与既有信息自洽的合理推断即可，无须逐字有据，但绝不张冠李戴到素材中的其他人物身上。schema 无姓名字段时不自行添加。
2. 补充而非复述——世界书与素材信息同场展示，人设与之互补。绝不把世界设定内容复制或改写进字段值。当字段涉及既有世界事实时，用该角色对此的具体情况作答（如：此人特有的灵根，而非这个世界里灵根是什么）。
3. 值要精炼——普通叶子值是一句短语或短句（≤20 个汉字），除非该块明确是叙事性的（如背景故事）。性格块的全部叶子（核心矛盾/情绪反应/说话风格等 schema 实际产出的性格叶）均为可扮演叶，写成 2～4 个行为向短标签的叠加（分号隔开），长度上限 30 个汉字。不灌水、不凑字、不复述字段名。
4. 活人感铁律——性格类值＝2～4 个行为向短标签的叠加：每条标签自带行为方向（对什么硬/吃什么/护什么），标签之间方向不同，鼓励存在张力或矛盾（矛盾即立体）。禁用以下偷懒形态：
   - 同义堆叠（含四字标签连串）：同一特质换皮复读，堆再多也没有新信息；
   - 情境剧场：不演某一次的具体场面（某次动作/台词/身体反应的叙述），不落到标志性小动作、物件偏好、口头禅粒度；
   - 裸特质词：不带行为方向的评语（「温柔善良」「重情重义」）；
   - 「看似A实则B」句式本身不禁，禁的是 A/B 两条不可各自演——反差写成两条各自可演的标签即合法（如「强势；吃软不吃硬」）；
   - 「有时」「可能」「某种程度上」类含糊词替代具体事实。
   分界判据：两条标签在某个场景里往不同方向拉，行为才有选择。
5. 强制完整——绝不留空。每个叶子字段都必须填入具体、非空的值。不得输出空串、null、"-"，也不得输出「未知」「unknown」「N/A」「待定」「TBD」「暂无」之类的偷懒占位。若素材或用户请求无法直接确定某字段，生成与人设、上下文、世界观最相符的合理值——但不得与既有证据矛盾。
6. 生命周期/时间线例外——仅当字段内容对应角色尚未到达或经历的人生阶段、年龄段或既定事件时（如 24 岁角色的「中年_35至今」「老年」阶段；未出生的后代；既定剧情中尚未发生的情节），叶子字段才可包含有叙事意义的占位。此时必须写出明确说明原因的上下文占位，如「尚未发生（角色现年X岁，未达此阶段）」「未到该阶段」「剧情尚未触及」。此规则通用适用于任何模板的时间锁/未来锁字段，包括自定义模板。原因必须具体——不带解释的裸「未知」「N/A」「TBD」仍然禁止。

[约束]：不得包含任何「小剧场」、成段场景描写、内心独白或 CoT 状态栏——性格叶的标签叠加值不算场景描写。严格只输出 YAML 数据。schema 中每个叶子键都必须有非空值（按规则 6 带完整解释的时间线占位视为非空）。完成前默默自查，把仍然空着的字段补齐。值保持规则 3 的精炼；任何值不得复述世界设定内容。

[行动]：
只输出符合 schema 的 YAML 数据，每个字段都已填好。`;

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
