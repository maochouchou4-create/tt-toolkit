/**
 * 任务默认模板（五任务：choice 选项生成＋persona 两段——策展/填充＋
 * summary 两段——小总结压缩/大总结合并）。
 * choice 部分＝唯一的任务模板（fork 出厂模板是上游猫娘 RP 特化演化，
 * 文本不搬不抄，按「通用 RP + flash 级模型」制版原则重写）；persona
 * 部分自 PersonaWeaver fork 默认提示词平移起步，策展段与生成段已按策展
 * 目录重写成文（见文末分节注释）。
 *
 * 制版原则落点：
 *   - 结构化分段标签：注入模块由引擎包裹 <persona>/<character>/…
 *     分段标签，文本模块自身保持短小；
 *   - 指令条目化：每条规则一行一事，正文说「要做什么」，末尾挂一句
 *     自查口径——模板里没有推理回合，自查句是模型落笔前的检查表；
 *   - 正向示例为主：few_shot 模块用「写法对照＋输出示例」把抽象口径落成
 *     可对照的句子（可关），示例一律虚构；
 *   - 戏剧观：每条选项必须推动点什么，且停在「正在发生、即将见分晓」的
 *     那一拍（core_rules 第 1/2/3 条＋few_shot 对照段）——只约束「动作
 *     对不对」的规则集会把每轮输出压成安全牌（迟疑、回避、原地打转），
 *     玩家看不到局面被推动；
 *   - 慢热闸：选项对关系与处境的推进与记忆注入里的现状相称、一次只推
 *     一小格（core_rules 第 9 条）。措辞只认 <external_memory> 这个自有
 *     包装标签、不绑具体记忆插件名——记忆插件换家时规则不用改；记忆
 *     本身写得含糊导致闸松是可见现象，不在这一层兜；
 *   - 池规则并入：反 OOC 要点与主体发起口径同写 core_rules 第 1 条
 *     ——同一约束每请求只出现一份；
 *   - 占位符：{{count}}/{{min_chars}}/{{max_chars}}/{{user}}/{{char}}。
 */
import {
    CATALOG_DEFINITIONS_CLOSE_TAG,
    CATALOG_DEFINITIONS_OPEN_TAG,
    OWNERSHIP_TABLE_CLOSE_TAG,
    OWNERSHIP_TABLE_OPEN_TAG,
    PERSONA_BLOCK_CATALOG,
    REFERENCE_MODULES_CLOSE_TAG,
    REFERENCE_MODULES_OPEN_TAG,
    TIER_WORDS,
    renderCatalog,
    renderOwnershipTable,
    type CatalogBlock,
} from './catalog';
import type { PromptConfig, TaskKey } from './types';

/**
 * 默认模板版本号：默认模板改版即 bump——storage 层据此识别存量旧默认
 * 快照并整键重建（任务键无编辑面＝不存在用户定制，覆盖无损）。
 */
export const DEFAULTS_VERSION = 19;

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
                    '写法对照（仅演示格式与写法，内容与当前剧情无关）——同一拍，「事后汇报」与「见分晓」的差别：',
                    '',
                    '不要（事后汇报）：她有些不高兴，转身走了。',
                    '要（见分晓）：她垂下眼睛，用小勺慢慢搅着咖啡，好一会儿才轻声说：「……我心里乱得很，容我缓缓。」',
                    '',
                    '不要（事后汇报）：{{user}} 决定试探她昨天夜里去了哪里。',
                    '要（见分晓）：{{user}} 压下心头的疑惑，放缓语气问道：「昨天夜里，你到底去了哪里？」',
                    '',
                    '事后汇报的毛病：动作做完了，没有悬着的东西，玩家不想知道接下来会怎样。见分晓的要点：话正说出口、动作正落下、对方的反应悬着——写「正在发生、即将见分晓」的那一拍。',
                    '',
                    '输出示例（三种主体混合：{{user}} 的行动、其他角色的主动行为、场景事件。留意其中的真人感——迟疑、岔开、小心思；以下同处一刻、各走一路，任一条都不以另一条为前情）：',
                    '每条带一句 aim——这条想撬动什么。',
                    '{',
                    '  "options": [',
                    '    {"title": "询问昨夜去向", "content": "{{user}} 压下心头的疑惑，放缓语气问道：「昨天夜里，你到底去了哪里？」", "aim": "想看她的说法与前情对不对得上"},',
                    '    {"title": "岔开话题", "content": "{{user}} 注意到她握着杯沿的手收紧了一瞬，却只是笑着把话头带开：「这酒不错——你从哪儿淘来的？」", "aim": "先把疑心收起来，换个轻松的场"},',
                    '    {"title": "反客为主", "content": "{{char}} 忽然放下茶杯，直视 {{user}} 的眼睛：「比起盘问我，不如先解释一下你袖口上沾的口红印。」", "aim": "把她质问的势头反推回去"},',
                    '    {"title": "骤然断电", "content": "整层楼的灯骤然熄灭，黑暗中传来玻璃碎裂声，电梯井的方向有人惊呼了一句什么。", "aim": "借突发打断这场对峙"}',
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
                    '1. 每条选项是一个剧情推进动作：可以是 {{user}} 的行动，也可以是其他角色（如 {{char}}）的主动行为，还可以是场景层面的事件。行动由其主体按自身人设发起：说什么、做什么、图什么，都要从这个角色本来会的方式里来，并对照世界书、角色卡与既有剧情，不与已确立的世界规则、人物关系及因果冲突。落笔前自查：这条选项的行动主体是谁？其人设里哪一条支持这个行动？（场景事件类自查：事件是否符合当前场景的逻辑。）',
                    '2. 每条选项必须推动点什么：信息、关系、处境、筹码——至少一样被这条选项推动。自查：如果选了它之后局面与选之前一模一样，这条不合格。',
                    '3. 每条选项写「正在发生、即将见分晓」的那一拍：话说出口、动作落下去、冲着具体的对象去，对方的反应悬着——让玩家选完想立刻看回帖；不写做完了的事后汇报。',
                    '4. 他人主体的选项写他接下来的主动行为，不替他写「对玩家刚才那一手的反应结果」——被撩到没有、被安慰到没有，由回帖揭晓，选项不剧透。',
                    '5. 反应要像真人：可以迟疑、回避、答非所问、带一点小心思，不必每条都直奔主题。',
                    '6. 全部以第三人称叙述书写：用角色名或他／她指代，不用「你」。优先使用场景内已有的对象、人物与线索。',
                    '7. 恰好 {{count}} 条，是此刻同时摆开的 {{count}} 种走法：每条都各自从正文停笔处另起一条路、各走各的方向，并各自面向一种玩家心态（如：直球推进、谨慎试探、果断出手、暂且回避），让不同心情的玩家都有顺手的一条；其中至少一条是当前局面向好的一步（正手），哪条是正手不标注，让玩家自己品。彼此不分先后、不互为因果——任何一条里发生的事都不得被当成另一条的前情。',
                    '8. 每条正文 {{min_chars}}～{{max_chars}} 字，写出具体的动作与言语，可含一句直接对白。',
                    '9. 慢热闸：若上下文存在记忆类注入（如 <external_memory> 里别的插件写入的既成事实、人物关系等），选项对关系与处境的推进必须与记忆中的现状相称——一次只推一小格，不跳级、不提前给结果（记忆里关系尚在「陌生」或「投缘」，选项至多是往相邻一档推的动作，不得摆出表白、摊牌这类越档举动）；无论行动主体是 {{user}}、其他角色还是场景事件，都过同一道闸。',
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
                // aim 只服务显示与楼层存档，不随发言外发给主模型——所以它是
                // 输出契约的一个键而不是写作规则里的一条：规则段每轮都要模型
                // 重读并占输出预算，而 aim 对模型的写作行为没有任何要求。
                content: [
                    '<format>',
                    '输出一个 JSON 对象，形如 {"options": [...]}，其中 options 是恰好 {{count}} 个元素的数组，每个元素形如：',
                    '{"title": "简短标题（10字内）", "content": "选项正文", "aim": "一句话写这条想撬动什么（如：想看她说法对不对得上／想探出他今晚的真目的／想让气氛松下来）"}',
                    'aim 只帮玩家判断这条选项冲什么去，不写进正文。',
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
                content: '请根据以上设定——尤其 <persona>（用户人设）与 <personality>（角色性格）两段，每条选项的行为方式必须从这两段出发——与 <current_scene> 中的当前场景，给出 {{count}} 条此刻并排的走法：每条都推动点什么、让人选完想立刻看到对方的反应。它们彼此独立，任何一条里发生的事都不得被当成另一条的前情。',
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// persona 任务默认模板（人设三段管线进统一提示词引擎）。
//
// 正文初版＝PersonaWeaver fork 默认提示词原样平移；策展段整段按策展目录
// 重写、生成段局部口径传导，已不是 fork 原文（占位符键名
// {{charInfo}}/{{greetings}}/{{template}}/{{input}}/{{userRequirements}} 仍是
// engine fillPersonaPlaceholders 的组装契约，禁止改名）。fork 原三段
// 消息序列（system 预设 / system 世界书参考 / user 指令）映成模块管线：
// 预设段源已退役（预设影响走传输层破限注入），现＝一个 inject 模块
// （persona_wi，role system）＋一个文本模块（指令正文，role user）；
// assistant prefill 仍由 generation.ts 在组装完成后追加（去 prefill
// 重试需要独立消息数组，不进模板）。
//
// 档案段的 <target_schema> 之后带两段目录派生正文：叶边界定义（每叶一行
// 「不装什么」）与归属优先级表（顺序同要求 7 的 ①–⑦，一行一对的两端叶）。
// 放档案段而不是只留策展段，是因为「同一个底线被写进三个叶」这类越界发生在
// 写值的那次请求里——定义只到策展段，等于把判据给错了请求。表体成文在
// catalog.ts 的 renderOwnershipTable；叶边界段本文件只放标签与
// {{catalog_definitions}} 宏位，宏值在填充层按本次 schema 现算（收敛口径见
// catalog.ts 的 definitionRowKeysFromSchema），两处都不另抄一份。
// ---------------------------------------------------------------------------

/**
 * 策展指令的任务头（首行标记）。
 *
 * 抽出常量而不是留在模板首行：它是「这一条消息是策展轮」的机判依据（冒烟的
 * SSE 桩按末条 user 消息的首行分派三段回执），写在两处时改了模板不必记得回来
 * 改桩——而漏改的后果是桩认不出段、与被测行为无关地炸。
 */
export const PERSONA_CURATOR_TASK_HEAD = '[任务：策展人设 schema]';

/** 策展指令（persona_curator 任务）：只产出 schema 键名，不填值。 */
const PERSONA_CURATOR_PROMPT = `${PERSONA_CURATOR_TASK_HEAD}
[背景：你要为使用者本人（User 自设）设计一份 YAML 人设 schema（只定键名，值为空）。这份人设将与世界书等素材一同被阅读——使用者始终同时看到这两份文档。]

<source_materials>
{{charInfo}}
</source_materials>

{{userRequirements}}

[原则——按顺序适用]：
1. 补充而非重复：世界书已载的信息（世界规则、传说、地理、阵营、其他角色的背景）不重复设字段；仅当字段捕捉 User 特有、且素材未提供的信息时才选。
2. 只写静态本质：人设是长期稳定的「他是谁」档案。禁止承载剧情进展或当前状态的字段（如「现状」「当前处境」「好感度」）；开场处境、关系进展、成长进度随剧情流动，由世界书与对话承担。「未解锁身世线索」「待解心结」一类伏笔字段除外——它们记录已埋下的静态事实，不追踪展开进度。
3. 效果密度：每个入选字段必须能改变 User 在场景中的行为方式或被对待方式——写了不影响任何互动的纯背景知识字段不选。判据是「有效果」，不是「数量少」：素材与需求撑得起多少有效块就选多少，顶层块上限 16（含机制挂载块）。
4. 选材顺序：①地基先行——清单标注「${TIER_WORDS.almost}」的块全部入选；②用户需求逐条映射——用户写到的每个方面都要有块承接；③扫描世界书与角色卡，信号成立的块补选；④题材机制逐个挂载。
5. 选用信号档位（清单行末字段）：「${TIER_WORDS.almost}」恒入选；「${TIER_WORDS.common}」默认入选（素材不反对即选）；其余档按信号成立入选。「指向时」「题材时」的成立判据＝素材或需求中出现该块对应的具体信息（人物、事件、机制、偏好）——题材沾边不成立。
6. 关系块只存 User 侧：关系类块（关系网／既有关系／组织归属等）只写 User 侧的称谓、态度与静态前史；对方人物的背景归世界书，档案不代写。
7. 叶数纪律与取舍：**结构层键不自造、不改名**——键名一律取自清单声明的叶名，不新造顶层键、不改清单用词、不写清单外的近义键。块入选后按该块信号强度**逐叶裁定去留**，各块独立、单块裁哪几个互不影响：
   - 先看该块内容在当前素材与需求下的信号密度；信号最强的叶入选并输出该键，信号不足的叶**不输出该键**（不写空串、不写占位、不留键）。
   - 入选的叶必须各有可扮演的具体内容；一个叶填不出区别于其他叶的任何信息，就不选它。
   - 唯一例外＝性格块可附类型学速记叶（用户给出 MBTI／九型结果时），该叶不在清单声明的叶数内。
   - 每块裁哪几个叶由该块信号强度决定；世界特有机制走机制挂载，不受此纪律约束。
   - 未入选的叶＝「这一维在本题材里不成立」，不是「忘了写」；档案段只负责把入选的键填满，不需要、也拿不到「哪些键本该留空」的信息。
8. 结构边界：通用块只从参考清单选。素材指向清单外的普通维度时，并入语义最相近的清单块作一叶，不新造顶层块；世界特有机制走机制挂载，块名与键名用该世界的原生词汇，不用通用类目词。

${REFERENCE_MODULES_OPEN_TAG}
${renderCatalog()}
${REFERENCE_MODULES_CLOSE_TAG}

<mechanism_mounts>
题材机制挂载（开放清单，不受上表限制）：世界书或用户需求中出现的世界特有机制，逐机制挂键——每个机制一个顶层块，1~6 叶。块名与键名用该机制在该世界的原生叫法（如「境界」「第二性别」「义体」），不用通用类目词（如「力量体系」「种族特性」）。常见机制与键示例：境界（境界/灵根资质/功法流派/体系短板）、特殊体质、第二性别（第二性别/信息素/标记状态/抑制剂/易感期）、义体改造、种族特性（特有能力/种族弱点/变身形态——形态变化归此，块名用具体种族名）、血液特性、契约真名、气场威压、命格气运、系统（面板功能/任务奖惩/系统限制）、穿越（前世记忆/已知剧情/剧情偏差应对）、抗性免疫、通灵、星际（公民等级/基因改造/舰船职务）。示例之外出现任何机制同样挂载。
</mechanism_mounts>

[约束]：顶层块不超过 16（含机制挂载块）。只输出 YAML 键名，值为空，键名用简体中文。不需要姓名字段。无任何解释。输出单个 \`\`\`yaml 代码块。

[行动]：
现在输出策展好的 YAML schema。`;

/** 按名取目录里的块（取不到即抛）：提示词里的块名必须来自目录。 */
function blockNamed(name: string): CatalogBlock {
    const block = PERSONA_BLOCK_CATALOG.find(b => b.name === name);
    if (!block) throw new Error(`策展目录里没有块「${name}」——提示词引用了目录外的块名`);
    return block;
}

/** 按名取目录里的叶键名（取不到即抛）：文风示例点的叶同理，目录改名后示例不能还指着旧名。 */
function leafName(blockName: string, name: string): string {
    for (const leaf of blockNamed(blockName).leaves) {
        if ('name' in leaf && leaf.name === name) return leaf.name;
    }
    throw new Error(`策展目录的「${blockName}」里没有叶「${name}」——提示词引用了目录外的叶名`);
}

/**
 * 叶子键成文：「块名·叶名」，两端都取自目录（取不到即抛）。要求 7 的归属顺序
 * 与三组反例指的全是叶子键——照抄字面量的话，目录改一次叶名，这些指令就静默
 * 指向一个不存在的键，而档案段正文与归属表都还在讲新键名：指令与目录当场互相
 * 打脸，模型无从判哪边为准。
 */
function leafKey(block: string, leaf: string): string {
    return `${blockNamed(block).name}·${leafName(block, leaf)}`;
}

/**
 * 裸块名成文：取自目录以证明它确实是块名（取不到即抛）。要求 7 的 ①⑥⑦ 归属到
 * 块而不是块里某一叶，块内怎么分由同一条里的分句/括号随后细分。
 */
function catalogBlock(name: string): string {
    return blockNamed(name).name;
}

/**
 * 行为心理类块名串成文（目录顺序）。分类是目录上的一个字段而不是这里的块名
 * 名单：名单与目录各存一份时，目录新增一个行为心理块只会静默漏进这串，而
 * 这串是生成端「可扮演叶」规则的适用范围，漏块即漏掉一条硬约束。
 */
function behaviorBlockList(): string {
    return PERSONA_BLOCK_CATALOG.filter(b => b.behavior === true).map(b => b.name).join('/');
}

/**
 * 生成契约要求 5 点名的偷懒占位词（成文进「」名单的那几个）。
 *
 * 单一真相源：要求 5 的正文由它插值成文，判据层（persona/redundancy.ts 的
 * 「没有内容」排除）从它派生的 PROFILE_PLACEHOLDER_VALUES 取——两边各抄一份时，
 * 契约新增一个占位词只会改到提示词那一侧，判据层照旧把两个都写「待定」的叶判成
 * 一对完全同值，而那个判据命中就驱动直改。
 */
const PLACEHOLDER_WORDS: ReadonlyArray<string> = ['未知', 'unknown', 'N/A', '待定', 'TBD', '暂无'];

/**
 * 判据层的「没有内容」词表＝占位词 ＋ 同一句里另被禁的 `null`。
 *
 * 空串与裸 `-` 不进这张表：前者是空、后者是列表记号，它们在判据层各有自己的
 * 形态判定，混进词表会让「形态」与「用词」两件事互相掩护。
 */
export const PROFILE_PLACEHOLDER_VALUES: ReadonlyArray<string> = [...PLACEHOLDER_WORDS, 'null'];

/** 人设填充指令的任务头（首行标记；机判用途见 PERSONA_CURATOR_TASK_HEAD）。 */
export const PERSONA_GEN_TASK_HEAD = '[任务：生成用户人设]';

/** 人设填充指令（persona_gen 任务）。 */
const PERSONA_GEN_PROMPT = `${PERSONA_GEN_TASK_HEAD}
[目标对象：User——使用者本人的扮演身份]
[背景：本档案是使用者本人（User）的长期人设，供 AI 在整个扮演过程中稳定呈现 User——它定义的是不随剧情改变的「他是谁」与「如何扮演」。下方素材定义了 User 所处的世界与他身边的人——素材中出现的其他人物（无论名字与 User 相近与否）都是 User 的关系对象，档案主体永远是 User 本人。当前处境、关系进展与剧情动态由对话演化，档案不追踪。]

<source_materials>
{{charInfo}}
{{greetings}}
</source_materials>

<target_schema>
{{template}}
</target_schema>

${CATALOG_DEFINITIONS_OPEN_TAG}
{{catalog_definitions}}
${CATALOG_DEFINITIONS_CLOSE_TAG}

{{input}}

<value_style_examples>
[文风示例——只示范「值写成 2～4 个行为向短标签的叠加算合格」，禁止照搬示例内容；你的值必须出自本对话的素材。]

${leafName('性格', '核心矛盾')}
  同义堆叠（禁）：冷静自持、从容不迫
  标签叠加（对）：强势；吃软不吃硬；护短
  情境剧场（也禁）：遭人质问吵闹只冷眼俯视并继续做事，直至对方自讨没趣
${leafName('性格', '情绪反应')}
  同义堆叠（禁）：遇事冷静，不易动怒
  标签叠加（对）：挑衅一律冷处理；遭背叛必清算
  情境剧场（也禁）：被当众拆穿先僵两秒，随后用一句更冷的玩笑找回场子
${leafName('性格', '待人差异')}
  同义堆叠（禁）：待人真诚，表里如一
  标签叠加（对）：生人面前能省话就省话；熟人局里话痨爱损人
  情境剧场（也禁）：初见只点头问好，跟室友却能聊到凌晨三点
</value_style_examples>

[要求]：
1. 主体锚定——所有字段写 User 本人；涉及其他人物的字段（来历、背景）以素材给出的关系为准组织，素材未覆盖的人物细节做与既有信息自洽的合理推断即可，无须逐字有据，但绝不张冠李戴到素材中的其他人物身上。schema 无姓名字段时不自行添加。
2. 补充而非复述——世界书与素材信息同场展示，人设与之互补。绝不把世界设定内容复制或改写进字段值。当字段涉及既有世界事实时，用该角色对此的具体情况作答（如：此人特有的灵根，而非这个世界里灵根是什么）。
3. 值要精炼——普通叶子值是一句短语或短句（≤40 个汉字），除非该块明确是叙事性的（如背景故事）。行为心理类块（${behaviorBlockList()}）的全部叶子（${leafName('性格', '核心矛盾')}/${leafName('性格', '情绪反应')}/${leafName('情绪光谱', '生气外显信号')}/${leafName('自我认知', '自我评价')}/${leafName('耻感与面子', '羞耻触发点')}/${leafName('恋爱', '心动反应')}等 schema 实际产出的行为心理叶）均为可扮演叶，写成 2～4 个行为向短标签的叠加（分号隔开），长度上限 40 个汉字。不灌水、不凑字、不复述字段名。
4. 活人感铁律——行为心理类值＝2～4 个行为向短标签的叠加：每条标签自带行为方向（对什么硬/吃什么/护什么），标签之间方向不同，鼓励存在张力或矛盾（矛盾即立体）。禁用以下偷懒形态：
   - 同义堆叠（含四字评语连串）：同一特质换皮复读，堆再多也没有新信息；
   - 情境剧场：不演某一次的具体场面（某次动作/台词/身体反应的叙述）；schema 中的细节叶（口头禅/标志性小动作一类）写稳定的行为向短语，同样不写成场面叙述；
   - 裸特质词：不带行为方向的评语（「温柔善良」「重情重义」）；
   - 「看似A实则B」句式本身不禁，禁的是 A/B 两条不可各自演——反差写成两条各自可演的标签即合法（如「强势；吃软不吃硬」）；
   - 「有时」「可能」「某种程度上」类含糊词替代具体事实。
   分界判据：两条标签在某个场景里往不同方向拉，行为才有选择。
   跨叶互补：行为心理类块的叶合起来不许整体同向（全部冷向/全部硬向）——至少一条标签写出反面或亲近松弛场景的具体行为（如熟人面前如何、被照顾时如何），仍须带行为方向，不得以裸评语充当这一条。
   跨叶不复述：同一条事实已经在别的叶写明时，本叶只写指向（如「因前述家族义务」），不把那条事实再写一遍。呼应可以有，抄写没有——回应方向不同即不算复读，原句照搬才算。
5. 强制完整——绝不留空。每个叶子字段都必须填入具体、非空的值。不得输出空串、null、"-"，也不得输出「${PLACEHOLDER_WORDS.join('」「')}」之类的偷懒占位。若素材或用户请求无法直接确定某字段，生成与人设、上下文、世界观最相符的合理值——但不得与既有证据矛盾。
6. 生命周期/时间线例外——仅当字段内容对应角色尚未到达或经历的人生阶段、年龄段或既定事件时（如 24 岁角色的「中年_35至今」「老年」阶段；未出生的后代；既定剧情中尚未发生的情节），叶子字段才可包含有叙事意义的占位。此时必须写出明确说明原因的上下文占位，如「尚未发生（角色现年X岁，未达此阶段）」「未到该阶段」「剧情尚未触及」。此规则通用适用于任何模板的时间锁/未来锁字段，包括自定义模板。原因必须具体——不带解释的裸「未知」「N/A」「TBD」仍然禁止。
7. 事实唯一归属——同一条事实只写进一个叶，别处不再复述；判断该进哪个叶时按下面顺序走，走通顺序的第一条即归属处，不再往下问：
   ① 通用底线、原则性的不做与不许 → ${catalogBlock('底线雷区')}；其中「他自己绝不去做」与「别人对他做不得」是两件事，前者归${leafName('底线雷区', '绝不做的事')}，后者归${leafName('底线雷区', '行为禁区')}。
   ② 他怎么称呼对方 → ${leafKey('既有关系', '专属称谓')}；若关系不在场、这个叫法对任何人都通用，才写${leafKey('基本信息', '别名与名号')}。
   ③ 对自己的误解与想不通 → ${leafKey('自我认知', '认知盲区')}。
   ④ 做不好的事 → 动手层面不会归${leafKey('技能专长', '技能盲区')}；学科上不懂归${leafKey('教育知识', '知识盲区')}；理解不了、想不通归${leafKey('自我认知', '认知盲区')}。
   ⑤ 压在他身上的外部要求 → ${leafKey('目标动机', '外部义务')}；他自己内心认不认这个目标 → ${leafKey('目标动机', '深层需要')}。
   ⑥ 长期放不下、一直没解决的 → ${catalogBlock('恩怨执念')}；他自己还没解开的那个结 → ${leafKey('成长弧', '待解心结')}；两人之间没挑明的那件事 → ${leafKey('既有关系', '未说破的心结')}。
   ⑦ 当下的相处方式与心动反应 → ${catalogBlock('恋爱')}；亲密关系的长期形态 → ${catalogBlock('情史依恋')}。
   归属顺序解决的是「这条事实归谁」。三个维度都该在场的情况（别人怎么看他／他内心缺什么／什么在推他行动）不适用归属顺序，那三件事本来就都要写，只是不能共用同一句素材。

${OWNERSHIP_TABLE_OPEN_TAG}
${renderOwnershipTable()}
${OWNERSHIP_TABLE_CLOSE_TAG}

[真实反例——以下三组都是同一份素材被写重了的实例，逐条对照，只做本地改写，不新增别的事实]:

反例一 · 同一份素材被塞进三个抽屉（归属错误，不是维度错误）
  重复写法——
    ${leafKey('底线雷区', '绝不做的事')}：绝不向外人透露妹妹的婚约
    ${leafKey('底线雷区', '行为禁区')}：不许任何人提妹妹的婚约
    ${leafKey('底线雷区', '禁触话题')}：妹妹的婚约
  为什么不合格：三叶把同一件事（替妹妹瞒着家里）写成了三遍，读者读到第二遍已经没有新信息。
  重写的版本——
    ${leafKey('底线雷区', '绝不做的事')}：绝不向外人道出妹妹被家里许人的事；当着外人的面连一个暗示都不给
    ${leafKey('底线雷区', '行为禁区')}：拿妹妹的名誉开玩笑、当众追问她的私事
    ${leafKey('底线雷区', '禁触话题')}：妹妹的婚约、家里的打算
  改法：各写各的——不做的事是「对外如何守住秘密」，行为禁区是「别人踩到什么会被他翻脸」，禁触话题是「哪个话题一提就僵」。

反例二 · 三个不同维度的叶共用同一句素材（这类不要合并，也不要各自复述）
  重复写法——
    ${leafKey('自我认知', '他人眼中形象')}：妹妹眼里他什么都能兜住
    ${leafKey('目标动机', '深层需要')}：他受够了做妹妹唯一的依靠
    ${leafKey('目标动机', '外部义务')}：父亲把「妹妹的事都靠他」定成他这辈子唯一的任务
  为什么不合格：三叶写出的是同一句「妹妹只有他」，三次读到的是同一件事。这是把「同母题」误当「同事实」。
  重写的版本——
    ${leafKey('自我认知', '他人眼中形象')}：在妹妹眼里他什么都能兜住，出了事也只会说「有我在」
    ${leafKey('目标动机', '深层需要')}：他受够了「必须有用」，要的是被当成需要照顾的人而不是永远兜底的人
    ${leafKey('目标动机', '外部义务')}：父亲把「把妹妹的事办成」定成他这辈子唯一的任务
  为什么合格：这三叶经常被读成重复，其实写的是三件事——别人怎么看他、他自己缺什么、外界要他做什么。本身就是要同时存在的三个维度，共用的只是那份「被需要」的素材。用同一份素材写三个维度是对的；错的是三叶写出同一句话。

反例三 · 事实已经在别的叶写过，本叶只要引用（跨叶复述）
  重复写法——
    ${leafKey('家庭出身', '家族义务或诅咒')}：父亲不许他改名字，也不许提家里的来历
    ${leafKey('成长弧', '现在态')}：仍是那个从不提家里的名字、从不提家里来历的人
  为什么不合格：第二叶把第一叶的内容换皮重写了一遍，读者只读一行就够了。
  重写的版本——
    ${leafKey('家庭出身', '家族义务或诅咒')}：父亲不许他改名字，也不许提家里的来历
    ${leafKey('成长弧', '现在态')}：家里来电一律当没看见；同学问起老家就岔开去做别的事
  改法：这两件事本身要分开写，但第二叶只写他「现在做什么」，不去解释「为什么不能提」——那个为什么已经在第一叶里。

[约束]：不得包含任何「小剧场」、成段场景描写、内心独白或 CoT 状态栏——行为心理叶的标签叠加值不算场景描写。严格只输出 YAML 数据。schema 中每个叶子键都必须有非空值（按规则 6 带完整解释的时间线占位视为非空）。完成前默默自查，把仍然空着的字段补齐。值保持规则 3 的精炼；任何值不得复述世界设定内容。

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
 * 回归红线）；persona 两任务＝前缀注入模块＋fork 指令正文；summary
 * 两任务＝任务指令＋源文本注入骨架。
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
        case 'summary_small':
            return summaryTaskConfig(SUMMARY_SMALL_PROMPT);
        case 'summary_big':
            return summaryTaskConfig(SUMMARY_BIG_PROMPT);
    }
}

// ---------------------------------------------------------------------------
// summary 任务默认模板（小总结压缩＋大总结合并）。任务指令正文为拍板
// 定稿文本，一字不差——压缩口径（事件一句话/伏笔必记/亲密情节只记结果/
// 心理只记结论/篇幅以覆盖关键信息为准）是对多份同类总结提示词实测口径的
// 收敛，改写＝破坏定稿。管线形态
// 与 persona 同构：一个文本模块（任务指令）＋一个注入模块（源文本）。
// 源文本不含引擎占位符，模块结构与 choice/persona 对齐保持单一管线形态。
// ---------------------------------------------------------------------------

/** 小总结任务指令（summary_small）。 */
const SUMMARY_SMALL_PROMPT = [
    '你是一部沉浸式角色扮演对话的剧情记录员。下面提供一段按时间先后排列的对话楼层，请把它们压缩成一份小总结，作为后续创作时的前情参考。',
    '',
    '要求：',
    '1. 用陈述句记录实际发生的事：不复述对白原文，不评价，不预测后续。',
    '2. 每个事件写一句话，包含时间（剧情内时间原文明示的照抄，未明示的按先后标注「第X幕」）、地点、在场人物。',
    '3. 相关事件合并；心理与氛围只记影响关系或剧情走向的结论，不照抄独白。',
    '4. 伏笔、承诺、约定、重要物品的得失、人物关系的每次变化必须记录，不得遗漏。',
    '5. 亲密情节只记录事实与结果（谁与谁发生了什么、关系如何变化），不展开过程细节。',
    '6. 篇幅以覆盖全部关键信息为准，通常 400 到 800 字，纯文本输出：不使用任何标题、编号、标签或 markdown 格式。',
].join('\n');

/** 大总结任务指令（summary_big）。 */
const SUMMARY_BIG_PROMPT = [
    '你是同一部角色扮演对话的剧情记录员。下面提供旧的大总结与近期的若干条小总结，请把它们合并成一份更新后的大总结，作为全部前剧情节的唯一参考。',
    '',
    '要求：',
    '1. 以时间为线索组织：按剧情阶段或日期分节，每节一段。',
    '2. 每节写明该段的关键剧情、地点、在场人物、发生的事。',
    '3. 只记已经发生的事实：陈述句，不复述对白，不评价，不预测。',
    '4. 合并重复信息：多份小总结里连续讲述的同一件事归并为一句话。',
    '5. 保留所有伏笔与未回收的线索、人物关系的每次变化、重要物品的流转；信息只增不减。',
    '6. 人物与专名以原文写法为准，不新造名字。',
    '7. 篇幅以覆盖全部关键信息为准（通常 800 到 1600 字），纯文本输出：不使用 markdown 格式，分节只用一行空行分隔。',
].join('\n');

/** summary 任务默认模板骨架：任务指令（system）＋前情源文本注入（user）。 */
function summaryTaskConfig(prompt: string): PromptConfig {
    return {
        id: 'default',
        name: '默认',
        defaultsVersion: DEFAULTS_VERSION,
        modules: [
            {
                kind: 'text',
                id: 'task',
                name: '任务指令',
                role: 'system',
                order: 10,
                enabled: true,
                content: prompt,
            },
            {
                kind: 'inject',
                id: 'inject_summary_source',
                name: '前情源文本',
                role: 'user',
                order: 20,
                enabled: true,
                source: 'summary_source',
            },
        ],
    };
}
