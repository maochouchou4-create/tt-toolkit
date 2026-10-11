/**
 * 任务默认模板（六任务：choice 选项生成＋persona 两段——策展/填充＋
 * summary 两段——小总结压缩/大总结合并＋summary_judge 总结时机判断）。
 * choice 部分＝唯一的任务模板（fork 出厂模板是上游猫娘 RP 特化演化，
 * 文本不搬不抄，按「通用 RP + flash 级模型」制版原则重写）；persona
 * 部分自 PersonaWeaver fork 默认提示词平移起步，v1.11.0 策展清单扩容批
 * 起按拍板稿重写（见文末分节注释）。
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
 * 快照并整键重建（任务键无编辑面＝不存在用户定制，覆盖无损）。
 */
export const DEFAULTS_VERSION = 14;

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
                    '输出示例（仅演示格式与写法，内容与当前剧情无关；三种视角混合：{{user}} 的行动、{{char}} 的主动行为与反应、场景层面的事件。留意其中「真人感」的写法——迟疑、岔开、回避、小心思，而不是每条都直奔主题；以下示例同处一刻、各走一路，任一条都不以另一条为前情）：',
                    '{',
                    '  "options": [',
                    '    {"title": "询问昨夜去向", "content": "{{user}} 压下心头的疑惑，放缓语气问道：「昨天夜里，你到底去了哪里？」"},',
                    '    {"title": "岔开话题", "content": "{{user}} 注意到她握着杯沿的手收紧了一瞬，却只是笑着把话头带开：「这酒不错——你从哪儿淘来的？」"},',
                    '    {"title": "沉默回避", "content": "她垂下眼睛，用小勺慢慢搅着咖啡，好一会儿才轻声说：「……我心里乱得很，容我缓缓。」"},',
                    '    {"title": "应激收声", "content": "楼道里突然传来脚步声，{{char}} 立刻噤声，一把攥住 {{user}} 的手腕，把两人拉进门后的阴影里。"},',
                    '    {"title": "反客为主", "content": "{{char}} 忽然放下茶杯，直视 {{user}} 的眼睛：「比起盘问我，不如先解释一下你袖口上沾的口红印。」"},',
                    '    {"title": "幽默化解", "content": "{{user}} 摸着后脑勺自嘲笑出了声：「行吧，算我多虑了——今晚这局，就当我先认输。」"},',
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
                    '1. 每条选项是一个具体的剧情推进动作：可以是 {{user}} 的行动，也可以是其他角色（如 {{char}}）的主动行为或反应，还可以是场景层面的事件发展。每条都要站得住——对照世界书、角色卡与既有剧情，不与已确立的世界规则、人物关系及因果冲突。',
                    '2. 每条选项由其主体按自身人设发起：说什么、做什么、图什么，都要从这个角色本来会的方式里来，不得出现该角色不会说的话、不会做的事。仅当情境压力极端（生死、重大转折、情绪失控）时允许小幅越线，且核心性格与说话方式不变形。落笔前自查：这条选项的行动主体是谁？其人设里哪一条支持这个行动？（场景事件类选项自查：事件是否符合当前场景的逻辑。）',
                    '3. 反应要像真人：可以迟疑、回避、答非所问、带一点小心思，不必每条都直奔主题。',
                    '4. 全部以第三人称叙述书写：用角色名或他／她指代，不用「你」。优先使用场景内已有的对象、人物与线索。',
                    '5. 恰好 {{count}} 条，是此刻同时摆开的 {{count}} 种走法：每条都各自从正文停笔处另起一条路，各走各的方向（如：推进对话、试探、采取行动、暂且回避），彼此不分先后、不互为因果——任何一条里发生的事都不得被当成另一条的前情。',
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
                content: '请根据以上设定——尤其 <persona>（用户人设）与 <personality>（角色性格）两段，每条选项的行为方式必须从这两段出发——与 <current_scene> 中的当前场景，给出 {{count}} 条可选的推进方向：它们同从正文落笔处起头，是此刻并排的 {{count}} 种走法，彼此独立。',
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// persona 任务默认模板（人设三段管线进统一提示词引擎）。
//
// 正文初版＝PersonaWeaver fork 默认提示词原样平移；v1.11.0 策展清单扩容批
// 起 curator 整段重写、gen 局部口径传导，不再是 fork 原文（占位符键名
// {{charInfo}}/{{greetings}}/{{template}}/{{input}}/{{userRequirements}} 仍是
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
1. 补充而非重复：世界书已载的信息（世界规则、传说、地理、阵营、其他角色的背景）不重复设字段；仅当字段捕捉 User 特有、且素材未提供的信息时才选。
2. 只写静态本质：人设是长期稳定的「他是谁」档案。禁止承载剧情进展或当前状态的字段（如「现状」「当前处境」「好感度」）；开场处境、关系进展、成长进度随剧情流动，由世界书与对话承担。「未解锁身世线索」「待解心结」一类伏笔字段除外——它们记录已埋下的静态事实，不追踪展开进度。
3. 效果密度：每个入选字段必须能改变 User 在场景中的行为方式或被对待方式——写了不影响任何互动的纯背景知识字段不选。判据是「有效果」，不是「数量少」：素材与需求撑得起多少有效块就选多少，顶层块上限 16（含机制挂载块）。
4. 选材顺序：①地基先行——清单标注「几乎必选」的块全部入选；②用户需求逐条映射——用户写到的每个方面都要有块承接；③扫描世界书与角色卡，信号成立的块补选；④题材机制逐个挂载。
5. 选用信号档位（清单行末字段）：「几乎必选」恒入选；「常选」默认入选（素材不反对即选）；其余档按信号成立入选。「指向时」「题材时」的成立判据＝素材或需求中出现该块对应的具体信息（人物、事件、机制、偏好）——题材沾边不成立。
6. 关系块只存 User 侧：关系类块（关系网/既有关系/组织归属等）只写 User 侧的称谓、态度与静态前史；对方人物的背景归世界书，档案不代写。
7. 叶数纪律：各块叶数即清单声明值，逐叶照抄清单，不增叶、不减叶、不改名；唯一例外＝性格块可附类型学速记叶（用户给出 MBTI/九型结果时）。
8. 结构边界：通用块只从参考清单选。素材指向清单外的普通维度时，并入语义最相近的清单块作一叶，不新造顶层块；世界特有机制走机制挂载，块名与键名用该世界的原生词汇，不用通用类目词。

<reference_modules>
基本信息——年龄/性别/身份/别名与名号；4 叶；几乎必选
外貌——整体印象/标志性特征/形体细节；3 叶；几乎必选
性格——核心矛盾/情绪反应/说话风格/待人差异；4 叶；几乎必选（可附类型学速记叶）
状态机——各态（概述＋行为特征＋切换触发）；≤4 态；行为或人格反差时
情绪光谱——情绪外露程度/生气外显信号/有效安抚手段/笑点哭点；4 叶；需要读空气或哄人戏时
自我认知——自我评价/他人眼中形象/认知盲区；3 叶；常选（破防与洞察戏的基座）
耻感与面子——羞耻触发点/面子敏感度/当众出丑反应；3 叶；调戏羞辱当众桥段指向时
恐惧软肋——最深恐惧/软肋人或物/会失态的威胁方式；3 叶；恐吓或保护戏指向时
底线雷区——绝不做的事/道德底线/禁触话题；3 叶；常选
价值观信念——道德观/信仰立场/金钱与人命排序；3 叶；两难抉择指向时（阵营归此）
创伤档案——创伤事件/信念伤疤/触发情境/未愈合部分；4 叶；背景有阴影素材时
心理防御——战逃僵讨好/危机优先级/求援习惯；3 叶；高压突发场面指向时
社交风格——社交能量/对陌生人默认态度/幽默类型/群体角色；4 叶；群像或初见戏指向时
教养礼仪——礼仪习惯/阶层烙印/对上下位者态度差；3 叶；阶层反差题材时
称呼偏好——喜欢的称呼/讨厌的称呼/外号来历；3 叶；多 NPC 场合或改口戏时
人际边界——肢体接触接受度/交友门槛/社交距离感；3 叶；慢热或距离感描写指向时
言谈习惯——口头禅/语气词/敬语粗口/口音方言/语言能力；5 叶；常选（说话味道的一致性）
声音气息——声线音色/音量语速/体温气息；3 叶；贴近戏或气味识人题材时
年龄错位——外表年龄/实际年龄/长寿带来的心态；3 叶；精灵吸血鬼重生者设定时
性别表达——性别认同/气质表达/伪装与暴露风险；3 叶；性别伪装类张力戏时
家庭出身——父母手足/门第阶层/家族义务或诅咒/童年环境；4 叶；家族戏或原生家庭题材时
关系网——挚友/宿敌/恩人仇家/人情债；4 叶；旧识登场或背景调查指向时
既有关系——与对方角色的历史关系/专属称谓/共同经历/未说破的心结；4 叶；熟人开局卡（青梅竹马/前恋人/宿敌）
组织归属——所属组织与职位/师承同门/组织义务与树敌；3 叶；身份带来便利与麻烦时
技能专长——专业技能/特殊天赋/水平对标/技能盲区；4 叶；常选（「明确不会什么」与「会什么」同重要）
战斗风格——武器偏好/战斗哲学/杀伤意志/战力对标；4 叶；动手戏题材时
职业经济——职业/收入档位/消费习惯/金钱观；4 叶；现代都市题材常选（职场身份归此）
教育知识——学历师承/知识强项/知识盲区/专业用语；4 叶；交谈可信度重要时（校园身份归此）
生活自理——厨艺家务/驾驶骑术/生存技能；3 叶；同居日常或野外剧情时
健康体质——体能/慢性旧伤/过敏用药/病中表现/感官锐钝；5 叶；病弱照顾或体能限制指向时
身体反应——忍痛阈值/脸红体质/流泪点/酒量醉态；4 叶；受伤饮酒或身体诚实桥段时
睡眠与梦——睡眠质量/失眠诱因/睡姿睡癖/梦话噩梦；4 叶；同床或噩梦安抚戏指向时
饮食禁忌——口味偏好/忌口/宗教种族禁忌；3 叶；宴席投喂桥段指向时
喜恶——喜欢/讨厌/雷点；3 叶；几乎必选
兴趣嗜好——爱好/消遣方式；2 叶；日常戏或约会选题时
作息怪癖——作息与出行规律/居住环境/标志性小动作；3 叶；偶遇蹲点与细节辨识戏时
随身物品——出门必带/口袋里有什么/常用工具；3 叶；搜身借用桥段指向时
重要所有物——传家信物与来历/贵重资产/拼命保护的东西；3 叶；物品钩子剧情时
宠物伴生——宠物契约兽/其能力脾气/与 User 默契；3 叶；伴生生物参与场景时
数字身份——账号矩阵/匿名马甲/数字足迹/反追踪习惯；4 叶；网恋掉马或人肉搜索题材时
声誉形象——圈内名声/绰号传说/公众认知与真实的落差/圈层差异；4 叶；NPC 初见预设立场重要时
权力地位——社会阶层/权力来源/追随者/权力的代价；4 叶；位分压迫戏时（宫廷位分归此）
法律边缘——前科/黑白人脉/灰色手段；3 叶；侦探律政或翻旧账剧情时
秘密马甲——隐藏身份/秘密全貌/知情者范围/暴露风险；4 叶；掉马与双面人生题材时
黑暗面——阴暗念头/暴力控制倾向/成瘾物/最不堪的一面；4 叶；阴沉底色或黑化剧情时
说谎识谎——撒谎能力与破绽/识谎能力/被质疑反应；3 叶；审讯试探攻防指向时
把柄操纵——会被什么诱惑/轻信谁/致命把柄；3 叶；反派设局剧情时
恩怨执念——复仇对象/报恩包袱/放不下的人；3 叶；长线恩怨动机时
前史——童年关键/人生转折/光辉事迹/黑历史/未解锁身世线索；5 叶；有背景故事素材时
目标动机——表层想要/深层需要/第一驱动力/受挫反应；4 叶；几乎必选（想要与需要不一致时人最有戏）
成长弧——过去态/现在态/可松动面/待解心结；4 叶；长线成长剧情时
戏点高光——名场面/帅点萌点/经典台词；3 叶；用户点名魅力点或高光期待时
恋爱——心动反应/被撩反应/吃醋表现/亲近后相处/会被什么打动；5 叶；素材或需求指向恋爱线时（性向面归 NSFW）
情史依恋——过往情史/依恋类型/关心人的方式/占有欲/恋爱观；5 叶；恋爱线且有旧伤包袱时
NSFW——性向/经验程度/敏感点/主导顺从倾向/禁忌/事后安抚；6 叶；用户需求或素材明确指向时
</reference_modules>

<mechanism_mounts>
题材机制挂载（开放清单，不受上表限制）：世界书或用户需求中出现的世界特有机制，逐机制挂键——每个机制一个顶层块，1~6 叶。块名与键名用该机制在该世界的原生叫法（如「境界」「第二性别」「义体」），不用通用类目词（如「力量体系」「种族特性」）。常见机制与键示例：境界（境界/灵根资质/功法流派/体系短板）、特殊体质、第二性别（第二性别/信息素/标记状态/抑制剂/易感期）、义体改造、种族特性（特有能力/种族弱点/变身形态——形态变化归此，块名用具体种族名）、血液特性、契约真名、气场威压、命格气运、系统（面板功能/任务奖惩/系统限制）、穿越（前世记忆/已知剧情/剧情偏差应对）、抗性免疫、通灵、星际（公民等级/基因改造/舰船职务）。示例之外出现任何机制同样挂载。
</mechanism_mounts>

[约束]：顶层块不超过 16（含机制挂载块）。只输出 YAML 键名，值为空，键名用简体中文。不需要姓名字段。无任何解释。输出单个 \`\`\`yaml 代码块。

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
待人差异
  同义堆叠（禁）：待人真诚，表里如一
  标签叠加（对）：生人面前能省话就省话；熟人局里话痨爱损人
  情境剧场（也禁）：初见只点头问好，跟室友却能聊到凌晨三点
</value_style_examples>

[要求]：
1. 主体锚定——所有字段写 User 本人；涉及其他人物的字段（来历、背景）以素材给出的关系为准组织，素材未覆盖的人物细节做与既有信息自洽的合理推断即可，无须逐字有据，但绝不张冠李戴到素材中的其他人物身上。schema 无姓名字段时不自行添加。
2. 补充而非复述——世界书与素材信息同场展示，人设与之互补。绝不把世界设定内容复制或改写进字段值。当字段涉及既有世界事实时，用该角色对此的具体情况作答（如：此人特有的灵根，而非这个世界里灵根是什么）。
3. 值要精炼——普通叶子值是一句短语或短句（≤40 个汉字），除非该块明确是叙事性的（如背景故事）。行为心理类块（性格/情绪光谱/自我认知/耻感与面子/恐惧软肋/心理防御/黑暗面/恋爱/情史依恋）的全部叶子（核心矛盾/情绪反应/生气外显信号/自我评价/羞耻触发点/心动反应等 schema 实际产出的行为心理叶）均为可扮演叶，写成 2～4 个行为向短标签的叠加（分号隔开），长度上限 40 个汉字。不灌水、不凑字、不复述字段名。
4. 活人感铁律——行为心理类值＝2～4 个行为向短标签的叠加：每条标签自带行为方向（对什么硬/吃什么/护什么），标签之间方向不同，鼓励存在张力或矛盾（矛盾即立体）。禁用以下偷懒形态：
   - 同义堆叠（含四字评语连串）：同一特质换皮复读，堆再多也没有新信息；
   - 情境剧场：不演某一次的具体场面（某次动作/台词/身体反应的叙述）；schema 中的细节叶（口头禅/标志性小动作一类）写稳定的行为向短语，同样不写成场面叙述；
   - 裸特质词：不带行为方向的评语（「温柔善良」「重情重义」）；
   - 「看似A实则B」句式本身不禁，禁的是 A/B 两条不可各自演——反差写成两条各自可演的标签即合法（如「强势；吃软不吃硬」）；
   - 「有时」「可能」「某种程度上」类含糊词替代具体事实。
   分界判据：两条标签在某个场景里往不同方向拉，行为才有选择。
   跨叶互补：行为心理类块的叶合起来不许整体同向（全部冷向/全部硬向）——至少一条标签写出反面或亲近松弛场景的具体行为（如熟人面前如何、被照顾时如何），仍须带行为方向，不得以裸评语充当这一条。
5. 强制完整——绝不留空。每个叶子字段都必须填入具体、非空的值。不得输出空串、null、"-"，也不得输出「未知」「unknown」「N/A」「待定」「TBD」「暂无」之类的偷懒占位。若素材或用户请求无法直接确定某字段，生成与人设、上下文、世界观最相符的合理值——但不得与既有证据矛盾。
6. 生命周期/时间线例外——仅当字段内容对应角色尚未到达或经历的人生阶段、年龄段或既定事件时（如 24 岁角色的「中年_35至今」「老年」阶段；未出生的后代；既定剧情中尚未发生的情节），叶子字段才可包含有叙事意义的占位。此时必须写出明确说明原因的上下文占位，如「尚未发生（角色现年X岁，未达此阶段）」「未到该阶段」「剧情尚未触及」。此规则通用适用于任何模板的时间锁/未来锁字段，包括自定义模板。原因必须具体——不带解释的裸「未知」「N/A」「TBD」仍然禁止。

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
        case 'summary_judge':
            return summaryTaskConfig(SUMMARY_JUDGE_PROMPT);
    }
}

// ---------------------------------------------------------------------------
// summary 任务默认模板（小总结压缩＋大总结合并＋总结时机判断）。任务指令
// 正文为拍板定稿
// 文本，一字不差——压缩口径（事件一句话/伏笔必记/亲密情节只记结果/纯文本
// 输出）是对多份同类总结提示词实测口径的收敛，改写＝破坏定稿。管线形态
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
    '3. 相关事件合并；忽略纯心理与氛围描写，只留情节事实与结果。',
    '4. 伏笔、承诺、约定、重要物品的得失、人物关系的每次变化必须记录，不得遗漏。',
    '5. 亲密情节只记录事实与结果（谁与谁发生了什么、关系如何变化），不展开过程细节。',
    '6. 全文 150 到 250 字，纯文本输出：不使用任何标题、编号、标签或 markdown 格式。',
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
    '7. 篇幅以覆盖全部关键信息为准（通常 300 到 600 字），纯文本输出：不使用 markdown 格式，分节只用一行空行分隔。',
].join('\n');

/**
 * 总结时机判断指令（summary_judge）。正文为拍板定稿文本，一字不差：
 * 好/坏时机对照式（借鉴 NVWA 预设脚本的判断提示词概念，表达自写）＋
 * JSON 输出契约。user 侧窗口上下文由判断器运行时拼装（非模板），
 * 经 summary_source 注入模块进管线（role user）。
 */
const SUMMARY_JUDGE_PROMPT = [
    'You are the summary timing judge for a story in progress. Decide whether the story has just reached a natural point at which to compile a story summary.',
    '',
    'Good moments to summarize: a scene or passage has just wrapped up; time or place has clearly changed; an important event has reached its outcome; a change in the relationship between characters has settled; an important agreement that needs to be remembered has been made.',
    '',
    'Poor moments to summarize: a dialogue or an action is still halfway through; a conflict or a suspense has just begun to unfold; what just happened is about to continue developing right away.',
    '',
    'Output only a JSON object in the form {"should_summarize": true or false, "reason": "one sentence"} and nothing else. Write the reason in the same language as the story.',
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
