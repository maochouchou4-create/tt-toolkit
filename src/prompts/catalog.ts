/**
 * 人设策展目录（数据层）：策展清单与回退骨架背后的唯一真相源——块名、
 * 档位、每叶的键名与边界定义、哪些叶属于回退骨架、同一类事实归属哪一叶。
 * 清单文本由它渲染成文，提示词正文与生成链不再另抄一份（同一个事实写在
 * 两处，改一处忘另一处就是这两份悄悄漂移）。
 *
 * 本文件只做数据与纯渲染：不 import 业务模块，也不得经业务 barrel 取它
 * ——persona barrel 会 re-export 冒烟与生成链，从那里取会在模块初始化期
 * 求值模板字面量（TDZ），并把冒烟拖进产物外溢到别的任务上；消费方一律
 * 从本叶子文件导入。
 */

/** 目录里的普通叶：键名 ＋ 边界定义 ＋ 是否属于回退骨架。 */
export interface CatalogLeaf {
    name: string;
    /** 叶的边界定义（谁的、装什么、明确不装什么）。空串＝该叶还没有定义——渲染时不出现这段，填上即自动生效。 */
    definition: string;
    /** 回退骨架成员。标记打在叶上而不是块上：块级标记会把「只差几叶」的整块毙掉。 */
    skeleton?: true;
}

/** 模板叶：叶不是键名，而是一段要模型逐条展开的声明（如状态机的「各态」）。 */
export interface CatalogTemplateLeaf {
    template: string;
    definition: string;
}

export interface CatalogBlock {
    name: string;
    /** 档位：almost＝几乎必选／common＝常选／conditional＝按 when 的成立条件入选。 */
    tier: 'almost' | 'common' | 'conditional';
    /** 块级条件限定语：conditional 档成文在行末（它就是那一档的「档位词」位），其余档留空。 */
    when?: string;
    /** 括号内的归类说明，成文为行末的（hint）。 */
    hint?: string;
    /** 叶数段的覆盖词面。模板叶块的「条数」由模板自带（状态机的「≤4 态」），不是叶的个数，按 leaves.length 成文会得到假量。 */
    countText?: string;
    /** 块内的叶（模板叶与普通叶混装）。 */
    leaves: ReadonlyArray<CatalogLeaf | CatalogTemplateLeaf>;
    /** 条件叶：只在素材给了才挂的一叶，不占声明叶数、不进回退骨架（缺素材就只剩编造一条路）。 */
    optionalLeaf?: { name: string; definition: string };
    /**
     * 行为心理类：生成端的值厚度与可扮演叶规则按这类块传导。分类随目录走
     * （手抄块名名单在目录改名后会静默指向旧名，且不报错）。
     */
    behavior?: true;
}

/**
 * 结构不变量（数据作者改块时必须守住）：
 *   - tier 为 conditional 的块必须带 when：conditional 档的档位位成文的就是
 *     when，缺了它那一档在清单行末只剩「；4 叶；」，模型读不出成立条件；
 *   - when 与 hint 分两段写、不许合成一段：合成后 hint 的括注会并进档位
 *     位，「档位词面」在同一行出现第二份，档位口径即不再单点；
 *   - countText 只配模板叶块：普通块按 leaves.length 成文就是它的真叶数，写死
 *     覆盖词面等于让叶数段与叶名串各说各话（名字串多一个、叶数段不跟着动的
 *     那一行，读起来像少叶）。
 *
 * 机判现状：countText 那条有独立断言（冒烟「countText 覆盖词面只配模板叶块」）；
 * 前两条只被策展清单的整段文本快照顺带锁住——快照锁的是成文结果而非这两个
 * 字段本身（写错会改动那一行文本而翻红，但字段的取值本身不另作比对）。
 */

/** 档位枚举 → 清单行末词面。conditional 档不出档位词，改为出 when。 */
export const TIER_WORDS: Readonly<Record<'almost' | 'common', string>> = {
    almost: '几乎必选',
    common: '常选',
};

/** 策展清单段的开闭标签：成文处（defaults.ts）与断言处（冒烟）共用一份字面量，两边各写一份就会漂成对不上的段切分。 */
export const REFERENCE_MODULES_OPEN_TAG = '<reference_modules>';
export const REFERENCE_MODULES_CLOSE_TAG = '</reference_modules>';

/**
 * 策展目录数据。块头四段（块名／叶数／档位或块级条件限定语／括号归类说明）
 * 与叶行成文格式都由 renderCatalog 拆字段落实，改词面改这里即可，不必改
 * 渲染函数。定义段（叶定义）逐叶成文接在行末——策展模型看不到没被渲染的
 * 东西，定义只存在代码里等于对模型零作用。
 */
export const PERSONA_BLOCK_CATALOG: ReadonlyArray<CatalogBlock> = [
    {
        name: '基本信息',
        tier: 'almost',
        leaves: [
            { name: '年龄', definition: '本人当前年龄与生辰。不装：身体状况（健康体质）、外表显出的年龄（年龄错位·外表年龄）。', skeleton: true },
            { name: '性别', definition: '本人认同的性别与生理性别。不装：气质与呈现方式（性别表达）。', skeleton: true },
            { name: '身份', definition: '在世界里被认定的身份与社会角色（学生／刑警／庶出／退役军人）。不装：职业的日常内容（职业经济）、所属组织（组织归属）。', skeleton: true },
            { name: '别名与名号', definition: '与在场任何人无关、普遍适用于本人的别名、绰号、尊称。不装：只对某个具体人成立的叫法（既有关系·专属称谓）。', skeleton: true },
        ],
    },
    {
        name: '外貌',
        tier: 'almost',
        leaves: [
            { name: '整体印象', definition: '第一眼给人的整体观感，一条带行为方向的标签。不装：单点细节（标志性特征、形体细节）。', skeleton: true },
            { name: '标志性特征', definition: '最容易被认出来的一两个特征（疤、发色、眼镜、笔迹）。不装：完整身形。', skeleton: true },
            { name: '形体细节', definition: '身形、姿态、着装习惯留下的身体轮廓印象。不装：与某个人专属的互动痕迹。', skeleton: true },
        ],
    },
    {
        name: '性格',
        tier: 'almost',
        hint: '可附类型学速记叶',
        behavior: true,
        leaves: [
            { name: '核心矛盾', definition: '身上同时存在、互相拉扯的两股力量，各写一条行为向标签。不装：单纯的缺点或单纯的优点。', skeleton: true },
            { name: '情绪反应', definition: '情绪被触发时的可见反应，按触发源分条写。不装：某一次的具体场面叙述。', skeleton: true },
            { name: '说话风格', definition: '说话的整体调子与节奏（慢条斯理／爱插科打诨）。不装：口头禅与句式细节（言谈习惯）、听说读写能力（言谈习惯·听说读写水平）。', skeleton: true },
            { name: '待人差异', definition: '对生人、熟人、亲近者三种对象分别呈现的不同面貌，各一条。不装：对所有人一致的稳定特质（那是核心矛盾）。', skeleton: true },
        ],
        optionalLeaf: { name: '类型学速记叶', definition: '用户在素材或需求里明确给出的类型学测试结果（MBTI／九型／大五等）照写，附一句他对这套标签的私下看法。' },
    },
    {
        name: '状态机',
        tier: 'conditional',
        when: '行为或人格反差时',
        countText: '≤4 态',
        leaves: [{ template: '每态含三键：状态名｜该态下的行为特征｜触发切换到该态的条件', definition: '该块不是一个值，而是至多 4 个命名状态，每态固定三键。不装：静态特质（那是性格）。≤4 态由策展段保证，档案段不得自行加第 5 态。' }],
    },
    {
        name: '情绪光谱',
        tier: 'conditional',
        when: '需要读空气或哄人戏时',
        behavior: true,
        leaves: [
            { name: '情绪外露程度', definition: '情绪在脸上的可见度（内敛到一眼看不出／什么都写在脸上）。不装：某个具体情绪的表现（性格·情绪反应）。', skeleton: true },
            { name: '生气外显信号', definition: '动怒时第一个可被察觉的动作或语气变化。不装：动怒的原因（心理防御·危机优先级）。', skeleton: true },
            { name: '有效安抚手段', definition: '什么方式真的能让这个人平静下来，按有效性排序。不装：安抚者的身份。', skeleton: true },
            { name: '笑点哭点', definition: '什么样的话／事真的能让他笑、让他哭，各一到两个具体触发点。不装：笑哭时的一般性格（性格·核心矛盾）。', skeleton: true },
        ],
    },
    {
        name: '自我认知',
        tier: 'common',
        hint: '破防与洞察戏的基座',
        behavior: true,
        leaves: [
            { name: '自我评价', definition: '他怎么评价自己，写行为向标签而非四字评语。不装：别人怎么看他（他人眼中形象）。', skeleton: true },
            { name: '他人眼中形象', definition: '常接触的人怎么看他。不装：他自己信不信这个评价。', skeleton: true },
            { name: '认知盲区', definition: '心智上的短路：他理解不了、想不通的那类事。不装：动手层面不会（技能专长·技能盲区）、学科知识不懂（教育知识·知识盲区）。', skeleton: true },
        ],
    },
    {
        name: '耻感与面子',
        tier: 'conditional',
        when: '调戏羞辱当众桥段指向时',
        behavior: true,
        leaves: [
            { name: '羞耻触发点', definition: '哪类行为或言语会让他觉得羞耻。不装：他自己不做的事（底线雷区·绝不做的事）、别人不许对他做的事（底线雷区·行为禁区）。' },
            { name: '面子敏感度', definition: '多大程度上在意别人怎么看他。不装：当众出丑当下他会做什么（当众出丑反应）。' },
            { name: '当众出丑反应', definition: '出丑当下他会做什么（当场走开／硬撑装没事／反咬一口）。不装：事后如何补救（成长弧·可松动面）。' },
        ],
    },
    {
        name: '恐惧软肋',
        tier: 'conditional',
        when: '恐吓或保护戏指向时',
        behavior: true,
        leaves: [
            { name: '最深恐惧', definition: '他最怕发生什么，写事件形态，不写情绪。不装：泛泛的「怕黑」「怕死」。', skeleton: true },
            { name: '软肋人或物', definition: '谁或什么能让他失去理智（一个具体的人、一件具体的东西）。不装：一般性的能力短板（技能盲区）。', skeleton: true },
            { name: '会失态的威胁方式', definition: '什么样的施压手段会让他当场崩掉。不装：威胁者的身份与动机（把柄操纵·致命把柄）。', skeleton: true },
        ],
    },
    {
        name: '底线雷区',
        tier: 'common',
        leaves: [
            { name: '绝不做的事', definition: '他自己绝不去做的行为，底线型人设的核心（「我不会做，但别人会逼我做」）。不装：别人不许对他做的事（行为禁区）、不许提的话题（禁触话题）。', skeleton: true },
            { name: '道德底线', definition: '他认定的、不因压力而变的原则性底线。不装：具体某一次的行为拒绝（绝不做的事）。', skeleton: true },
            { name: '行为禁区', definition: '别人对他做不得的事，会触怒他或引发冲突的行为。不装：他自己不做的事（绝不做的事）、话题层面的禁区（禁触话题）。' },
            { name: '禁触话题', definition: '提了就气氛变差的具体话题（含过往、关系、某些人）。不装：行为层面的禁区（行为禁区）、他自己不做的事（绝不做的事）。' },
        ],
    },
    {
        name: '价值观信念',
        tier: 'conditional',
        when: '两难抉择指向时',
        hint: '阵营归此',
        leaves: [
            { name: '道德观', definition: '他对对错的实际判断依据（写他怎么取舍，不写教条）。不装：具体底线（底线雷区·道德底线）。' },
            { name: '信仰立场', definition: '他信什么、不信什么，信到什么程度。不装：宗教或种族禁忌（饮食禁忌·宗教种族禁忌）。' },
            { name: '金钱与人命排序', definition: '被逼二选一时他先保什么。不装：日常金钱观（职业经济·金钱观）。' },
        ],
    },
    {
        name: '创伤档案',
        tier: 'conditional',
        when: '背景有阴影素材时',
        leaves: [
            { name: '创伤事件', definition: '发生过的那件事本身，一句。不装：当时的反应（触发情境）。' },
            { name: '信念伤疤', definition: '这件事留下的、至今仍在起作用的那条信念。不装：创伤事件的复述。' },
            { name: '触发情境', definition: '什么场景会让这件事被重新激活。不装：他的应对方式（心理防御·战逃僵讨好）。' },
            { name: '未愈合部分', definition: '至今还在流血、尚未处理完的那部分。不装：可疏导的方向（成长弧·待解心结）。' },
        ],
    },
    {
        name: '心理防御',
        tier: 'conditional',
        when: '高压突发场面指向时',
        behavior: true,
        leaves: [
            { name: '战逃僵讨好', definition: '危机来临时他的第一本能，四个方向里选一到两个。不装：危机本身。' },
            { name: '危机优先级', definition: '同时出多件事时他先处理哪件。不装：处理结果。' },
            { name: '求援习惯', definition: '愿不愿意求人、向谁求、怎么开口。不装：社交能量（社交风格·社交能量）。' },
        ],
    },
    {
        name: '社交风格',
        tier: 'conditional',
        when: '群像或初见戏指向时',
        leaves: [
            { name: '社交能量', definition: '与人相处的电量消耗速度（耗尽型／充电型）。不装：对具体某个人的态度。' },
            { name: '对陌生人默认态度', definition: '面对没见过的对象，他的默认姿态。不装：对熟人的真实态度（性格·待人差异）。' },
            { name: '幽默类型', definition: '他讲笑话的路子（冷面吐槽／一本正经胡说）。不装：笑话本身。' },
            { name: '群体角色', definition: '他在一个群体里默认占什么位（发言人／边缘人／和事佬）。不装：具体某段群体关系。' },
        ],
    },
    {
        name: '教养礼仪',
        tier: 'conditional',
        when: '阶层反差题材时',
        leaves: [
            { name: '礼仪习惯', definition: '日常礼节上的具体习惯（做什么、不做什么）。不装：阶层标签本身。' },
            { name: '阶层烙印', definition: '成长环境在他身上留下的、藏不住的痕迹。不装：家世与门第（家庭出身）。' },
            { name: '对上下位者态度差', definition: '对上和对下的态度差在哪儿。不装：对平辈的态度。' },
        ],
    },
    {
        name: '称呼偏好',
        tier: 'conditional',
        when: '多 NPC 场合或改口戏时',
        leaves: [
            { name: '喜欢的称呼', definition: '他愿意被这样叫。不装：别人实际怎么叫他（既有关系·专属称谓）。' },
            { name: '讨厌的称呼', definition: '他明确不接受的说法及原因。不装：关系史（既有关系·关系定性）。' },
            { name: '外号来历', definition: '这个外号是怎么来的。不装：外号本身（喜欢的称呼）。' },
        ],
    },
    {
        name: '人际边界',
        tier: 'conditional',
        when: '慢热或距离感描写指向时',
        leaves: [
            { name: '肢体接触接受度', definition: '哪些接触可以接受、哪些不行。不装：恋爱中的亲近（恋爱·亲近后相处）。' },
            { name: '交友门槛', definition: '什么样的人能进他的圈。不装：与人的历史（既有关系）。' },
            { name: '社交距离感', definition: '默认与他人保持多远的距离。不装：情绪上的距离。' },
        ],
    },
    {
        name: '言谈习惯',
        tier: 'common',
        hint: '说话味道的一致性',
        leaves: [
            { name: '口头禅', definition: '反复出现的那一两句。不装：句首句尾挂的词（语气词）。', skeleton: true },
            { name: '语气词', definition: '高频挂在句首句尾的词。不装：口头禅。', skeleton: true },
            { name: '敬语粗口', definition: '对谁用什么敬语、什么场合会爆粗。不装：说话的整体调子（性格·说话风格）。' },
            { name: '口音方言', definition: '乡音、方言词、语速带出的地域感。不装：听说读写能力。' },
            { name: '听说读写水平', definition: '听、说、读、写四方面的实际水平（如读写远好于听说）。不装：说话风格、口头禅。' },
        ],
    },
    {
        name: '声音气息',
        tier: 'conditional',
        when: '贴近戏或气味识人题材时',
        leaves: [
            { name: '声线音色', definition: '声音的质地与辨识度。不装：响度与快慢（音量语速）。' },
            { name: '音量语速', definition: '说话的响度与快慢。不装：内容风格。' },
            { name: '体温气息', definition: '贴得近才感觉得到的东西（体温偏凉／带血腥气）。不装：其他身体状态（健康体质）。' },
        ],
    },
    {
        name: '年龄错位',
        tier: 'conditional',
        when: '精灵吸血鬼重生者设定时',
        leaves: [
            { name: '外表年龄', definition: '看起来多大。不装：真实岁数（基本信息·年龄）。' },
            { name: '实际年龄', definition: '真实岁数。不装：外表年龄。' },
            { name: '长寿带来的心态', definition: '活得久在他身上留下的痕迹（不急／见过太多）。不装：年龄数字本身。' },
        ],
    },
    {
        name: '性别表达',
        tier: 'conditional',
        when: '性别伪装类张力戏时',
        leaves: [
            { name: '性别认同', definition: '他认同的性别。不装：生理性别（基本信息·性别）。' },
            { name: '气质表达', definition: '气质偏硬、偏柔还是中性，靠什么呈现。不装：自我认同。' },
            { name: '伪装与暴露风险', definition: '伪装成另一种呈现时的破绽在哪、什么时候会露。不装：暴露后的后果。' },
        ],
    },
    {
        name: '家庭出身',
        tier: 'conditional',
        when: '家族戏或原生家庭题材时',
        leaves: [
            { name: '父母手足', definition: '谁在、什么关系、现在什么状态。不装：他对他们的态度（性格·待人差异，家人属「待人差异」的亲近者一档）、他对家人欠着的义务（目标动机·外部义务）。' },
            { name: '门第阶层', definition: '这个家庭在社会上的位置。不装：教养痕迹（教养礼仪·阶层烙印）。' },
            { name: '家族义务或诅咒', definition: '这个家压在他身上的、外部的要求或禁忌（考出成绩、替父还债、不得说某个姓）。不装：他内心想不想做（目标动机·深层需要）。' },
            { name: '童年环境', definition: '长大的物理与情感环境（缺人、动荡、被忽视）。不装：创伤事件。' },
        ],
    },
    {
        name: '关系网',
        tier: 'conditional',
        when: '旧识登场或背景调查指向时',
        leaves: [
            { name: '挚友', definition: '一个真实的、长期的朋友。不装：与「用户」的关系（既有关系）。' },
            { name: '宿敌', definition: '与他长期对立、至今未了的那个人。不装：报复动机（恩怨执念·复仇对象）。' },
            { name: '恩人仇家', definition: '欠过谁、谁欠过他，各一条。不装：具体账目（人情债）。' },
            { name: '人情债', definition: '一笔具体待还或已还的账。不装：恩人仇家的名单。' },
        ],
    },
    {
        name: '既有关系',
        tier: 'conditional',
        when: '熟人开局卡',
        hint: '青梅竹马/前恋人/宿敌',
        leaves: [
            { name: '关系定性', definition: '这段关系的性质（兄妹／青梅竹马／前恋人／名义上的）。不装：具体经历（共同经历）。' },
            { name: '专属称谓', definition: '只在他与「用户」之间成立的叫法与叫法背后的默契。不装：对所有人都适用的别名（基本信息·别名与名号）。' },
            { name: '共同经历', definition: '两人一起经历过、有共同记忆的具体事件。不装：关系的性质（关系定性）。' },
            { name: '未说破的心结', definition: '双方都知道、都没挑明的那件事。不装：他自己的成长课题（成长弧·待解心结）。' },
        ],
    },
    {
        name: '组织归属',
        tier: 'conditional',
        when: '身份带来便利与麻烦时',
        leaves: [
            { name: '所属组织与职位', definition: '属于哪个组织、什么位置。不装：组织带来的便利与代价（权力地位·权力的代价）。' },
            { name: '师承同门', definition: '跟谁学的、同门有谁。不装：自学能力（教育知识·知识强项）。' },
            { name: '组织义务与树敌', definition: '组织对他的要求，以及他在组织里的敌人。不装：家族义务（家庭出身·家族义务或诅咒）。' },
        ],
    },
    {
        name: '技能专长',
        tier: 'common',
        hint: '「明确不会什么」与「会什么」同重要',
        leaves: [
            { name: '专业技能', definition: '受过训练、能靠它吃饭的手艺。不装：没训练也具备的天赋（特殊天赋）。', skeleton: true },
            { name: '特殊天赋', definition: '没受过训练也具备的异常能力。不装：能力的对标评价（水平对标）。' },
            { name: '水平对标', definition: '这些能力到什么程度（能打过几个谁／行业第几）。不装：明确不会什么（技能盲区）。' },
            { name: '技能盲区', definition: '动手层面明确不会做的事（不会做饭／不会开车／不会缝纫）。不装：心智上想不通（自我认知·认知盲区）、学科知识不懂（教育知识·知识盲区）。', skeleton: true },
        ],
    },
    {
        name: '战斗风格',
        tier: 'conditional',
        when: '动手戏题材时',
        leaves: [
            { name: '武器偏好', definition: '惯用什么、为什么。不装：杀伤意志。' },
            { name: '战斗哲学', definition: '打架时脑子里遵循什么原则。不装：招式细节。' },
            { name: '杀伤意志', definition: '能不能下狠手、对谁下不了手。不装：战力高低。' },
            { name: '战力对标', definition: '能打赢什么量级的对手。不装：非战斗类技能（技能专长）。' },
        ],
    },
    {
        name: '职业经济',
        tier: 'conditional',
        when: '现代都市题材',
        hint: '职场身份归此',
        leaves: [
            { name: '职业', definition: '以什么为生、在社会分工里的位置。不装：所属组织（组织归属）。' },
            { name: '收入档位', definition: '钱有多少、来源粗略结构。不装：金钱观。' },
            { name: '消费习惯', definition: '钱花在哪、花得爽不爽。不装：收入档位。' },
            { name: '金钱观', definition: '钱对这个人意味着什么（安全感／自由／无所谓）。不装：金钱与人命的取舍（价值观信念·金钱与人命排序）。' },
        ],
    },
    {
        name: '教育知识',
        tier: 'conditional',
        when: '交谈可信度重要时',
        hint: '校园身份归此',
        leaves: [
            { name: '学历师承', definition: '读到什么程度、跟谁学。不装：组织内的师承（组织归属·师承同门）。' },
            { name: '知识强项', definition: '在哪门学问上确实懂、能唬住人。不装：动手能力（技能专长）。' },
            { name: '知识盲区', definition: '学科知识上明确不懂的领域（不懂化学／不懂法条／不懂星际政治）。不装：动手层面不会（技能专长·技能盲区）、心智上想不通（自我认知·认知盲区）。' },
            { name: '专业用语', definition: '他所在领域会说的行话与黑话。不装：口头禅（言谈习惯·口头禅）。' },
        ],
    },
    {
        name: '生活自理',
        tier: 'conditional',
        when: '同居日常或野外剧情时',
        leaves: [
            { name: '厨艺家务', definition: '做饭、打扫、缝补这类日常家务的手上功夫。不装：能力水平对标（技能专长·水平对标）。' },
            { name: '驾驶骑术', definition: '驾驶与操纵类（开车、骑马、开船、操控机械）。不装：野外求生（生存技能）。' },
            { name: '生存技能', definition: '野外与危机环境下的求生手段（生火、找水、搭帐篷）。不装：战斗（战斗风格）。' },
        ],
    },
    {
        name: '健康体质',
        tier: 'conditional',
        when: '病弱照顾或体能限制指向时',
        leaves: [
            { name: '体能', definition: '体力的大致水平与耐力。不装：病弱状态（病中表现）。' },
            { name: '慢性旧伤', definition: '长期存在、治不好的身体问题（腰伤、旧骨折）。不装：忍痛阈值（身体反应·忍痛阈值）。' },
            { name: '过敏用药', definition: '过敏的东西与常备药。不装：病中表现。' },
            { name: '病中表现', definition: '生病或受伤时的具体表现（发烧说胡话／一受伤就发烧）。不装：体能。' },
            { name: '感官锐钝', definition: '哪几种感官退化或迟钝（近视、听力下降、失去痛觉）。不装：忍痛阈值。' },
        ],
    },
    {
        name: '身体反应',
        tier: 'conditional',
        when: '受伤饮酒或身体诚实桥段时',
        leaves: [
            { name: '忍痛阈值', definition: '多痛才叫得出、会怎么忍。不装：慢性旧伤（健康体质·慢性旧伤）。' },
            { name: '脸红体质', definition: '什么情况下会先脸红（被夸／被靠近／喝酒）。不装：害羞的心理含义（恋爱·心动反应）。' },
            { name: '流泪点', definition: '什么情形会掉眼泪。不装：哭的次数。' },
            { name: '酒量醉态', definition: '酒量多少、醉了什么样。不装：不能喝酒的原因（饮食禁忌·忌口）。' },
        ],
    },
    {
        name: '睡眠与梦',
        tier: 'conditional',
        when: '同床或噩梦安抚戏指向时',
        leaves: [
            { name: '睡眠质量', definition: '睡得好不好、几点睡。不装：睡不着的原因（失眠诱因）。' },
            { name: '失眠诱因', definition: '什么让他睡不着。不装：睡眠质量。' },
            { name: '睡姿睡癖', definition: '睡着时的样子与习惯动作。不装：与他人的同床互动（恋爱·亲近后相处）。' },
            { name: '梦话噩梦', definition: '说梦话的具体形态、反复出现的噩梦。不装：醒着时的心理防御。' },
        ],
    },
    {
        name: '饮食禁忌',
        tier: 'conditional',
        when: '宴席投喂桥段指向时',
        leaves: [
            { name: '口味偏好', definition: '偏甜偏咸、能吃辣到什么程度。不装：不能吃的东西（忌口）。' },
            { name: '忌口', definition: '明确不能吃／不碰的东西（过敏之外的道德或习惯性拒绝）。不装：过敏用药（健康体质·过敏用药）。' },
            { name: '宗教种族禁忌', definition: '因信仰或种族而不能碰的东西。不装：口味偏好。' },
        ],
    },
    {
        name: '喜恶',
        tier: 'almost',
        leaves: [
            { name: '喜欢', definition: '他主动喜欢的东西、愿意为之花时间的事。不装：能让他心动的人（恋爱·心动反应）。', skeleton: true },
            { name: '讨厌', definition: '他主动厌恶、避之不及的东西。不装：底线（底线雷区）、别人的行为禁区。', skeleton: true },
        ],
    },
    {
        name: '兴趣嗜好',
        tier: 'conditional',
        when: '日常戏或约会选题时',
        leaves: [
            { name: '爱好', definition: '单项的、可持续的爱好。不装：放松时的具体做法（消遣方式）。' },
            { name: '消遣方式', definition: '放松时具体做什么（钓鱼、喝酒、打游戏）。不装：爱好。' },
        ],
    },
    {
        name: '作息怪癖',
        tier: 'conditional',
        when: '偶遇蹲点与细节辨识戏时',
        leaves: [
            { name: '作息与出行规律', definition: '固定的作息与常去的地方（几点出门、坐哪路公交）。不装：睡眠质量（睡眠与梦·睡眠质量）。' },
            { name: '居住环境', definition: '他住的地方什么样（乱／一尘不染／墙上贴满东西）。不装：所属组织（组织归属）。' },
            { name: '标志性小动作', definition: '一个无意识的小动作（转笔、摸后颈）。不装：口头禅（言谈习惯·口头禅）。' },
        ],
    },
    {
        name: '随身物品',
        tier: 'conditional',
        when: '搜身借用桥段指向时',
        leaves: [
            { name: '出门必带', definition: '出门一定会带的那件东西。不装：口袋里的杂物（口袋里有什么）。' },
            { name: '口袋里有什么', definition: '随身携带的实际物品清单。不装：贵重资产（重要所有物·贵重资产）。' },
            { name: '常用工具', definition: '日常用来做事的工具（刀、针、账本）。不装：武器（战斗风格·武器偏好）。' },
        ],
    },
    {
        name: '重要所有物',
        tier: 'conditional',
        when: '物品钩子剧情时',
        leaves: [
            { name: '传家信物与来历', definition: '一件家族遗留的物件及其来路。不装：日常随身物（随身物品）。' },
            { name: '贵重资产', definition: '值钱的东西（房产、存了多少）。不装：传家信物。' },
            { name: '拼命保护的东西', definition: '拼了命也不肯交出去的东西，不一定贵。不装：随身物品。' },
        ],
    },
    {
        name: '宠物伴生',
        tier: 'conditional',
        when: '伴生生物参与场景时',
        leaves: [
            { name: '宠物契约兽', definition: '是什么、什么来头。不装：它的能力与脾气。' },
            { name: '其能力脾气', definition: '这东西能干什么、什么性子、听不听话。不装：它与人的关系。' },
            { name: '与 User 默契', definition: '它与「用户」之间形成的相处默契。不装：它与别人的关系。' },
        ],
    },
    {
        name: '数字身份',
        tier: 'conditional',
        when: '网恋掉马或人肉搜索题材时',
        leaves: [
            { name: '账号矩阵', definition: '名下有哪几个账号、各是什么身份。不装：为躲人开的那个号（匿名马甲）。' },
            { name: '匿名马甲', definition: '为隐藏真实身份而开的号。不装：账号全貌。' },
            { name: '数字足迹', definition: '网上留下的痕迹（发过的帖、玩过的游戏）。不装：如何规避（反追踪习惯）。' },
            { name: '反追踪习惯', definition: '日常规避被找到的做法。不装：身份被揭穿的后果。' },
        ],
    },
    {
        name: '声誉形象',
        tier: 'conditional',
        when: 'NPC 初见预设立场重要时',
        leaves: [
            { name: '圈内名声', definition: '在熟悉他的那个圈子里，他是个什么名声。不装：公众怎么看（公众认知与真实的落差）。' },
            { name: '绰号传说', definition: '外号与围绕它的那段传闻。不装：本人喜不喜欢这个绰号（喜恶）。' },
            { name: '公众认知与真实的落差', definition: '外人以为的他是怎样的、实际是怎样的，差在哪儿。不装：他自己怎么评价（自我认知·自我评价）。' },
            { name: '圈层差异', definition: '不同圈子怎么看他、为什么不一样。不装：圈内名声的全貌。' },
        ],
    },
    {
        name: '权力地位',
        tier: 'conditional',
        when: '位分压迫戏时',
        hint: '宫廷位分归此',
        leaves: [
            { name: '社会阶层', definition: '他在权力结构里的位置（世族旁支／寒门出身／中层）。不装：门第（家庭出身·门第阶层）。' },
            { name: '权力来源', definition: '这份权力从哪来（血统、军功、钱、别人给的）。不装：组织义务（组织归属·组织义务与树敌）。' },
            { name: '追随者', definition: '谁跟着他、跟着他做什么。不装：一般人际资源（关系网）。' },
            { name: '权力的代价', definition: '这份权力要付出什么、他失去过什么。不装：权力的滥用。' },
        ],
    },
    {
        name: '法律边缘',
        tier: 'conditional',
        when: '侦探律政或翻旧账剧情时',
        leaves: [
            { name: '前科', definition: '过去留下的案底或污点事件。不装：还没被发现的秘密（秘密马甲）。' },
            { name: '黑白人脉', definition: '与哪些道上人有来往。不装：具体欠了什么（关系网·人情债）。' },
            { name: '灰色手段', definition: '他用的、见不得光但有效的做法。不装：道德底线（底线雷区·道德底线）。' },
        ],
    },
    {
        name: '秘密马甲',
        tier: 'conditional',
        when: '掉马与双面人生题材时',
        leaves: [
            { name: '隐藏身份', definition: '对外身份之外的真实那一层。不装：秘密的全貌。' },
            { name: '秘密全貌', definition: '那件事到底有多深（牵扯多少人、多大代价）。不装：谁知道（知情者范围）。' },
            { name: '知情者范围', definition: '目前有几个人知道。不装：暴露后的场面。' },
            { name: '暴露风险', definition: '多大可能被发现、什么时候最危险。不装：日常规避做法（数字身份·反追踪习惯）。' },
        ],
    },
    {
        name: '黑暗面',
        tier: 'conditional',
        when: '阴沉底色或黑化剧情时',
        behavior: true,
        leaves: [
            { name: '阴暗念头', definition: '他自己都厌恶、但确实会冒出来的念头。不装：行为约束（底线雷区）。' },
            { name: '暴力控制倾向', definition: '动手与支配的倾向，具体怎么个做法。不装：能力侧的战斗方式（战斗风格）。' },
            { name: '成瘾物', definition: '离不开的东西（酒、药、某个人）。不装：醉后的表现（身体反应·酒量醉态）。' },
            { name: '最不堪的一面', definition: '连他自己都不愿承认的那部分。不装：阴暗念头的复述。' },
        ],
    },
    {
        name: '说谎识谎',
        tier: 'conditional',
        when: '审讯试探攻防指向时',
        leaves: [
            { name: '撒谎能力与破绽', definition: '撒谎的水平与最容易露的地方。不装：他在骗谁（既有关系·关系定性）。' },
            { name: '识谎能力', definition: '能不能看穿别人在骗他。不装：他自己是否在骗。' },
            { name: '被质疑反应', definition: '被当面质问时的第一反应。不装：撒谎的破绽。' },
        ],
    },
    {
        name: '把柄操纵',
        tier: 'conditional',
        when: '反派设局剧情时',
        leaves: [
            { name: '会被什么诱惑', definition: '什么样的人和条件能让他破例。不装：一般喜好（喜恶）。' },
            { name: '轻信谁', definition: '他容易对谁放下戒心。不装：他主动设的门槛（人际边界·交友门槛）。' },
            { name: '致命把柄', definition: '一旦曝光就完蛋的那件事，可以被别人拿来做筹码。不装：身份秘密（秘密马甲·隐藏身份）。' },
        ],
    },
    {
        name: '恩怨执念',
        tier: 'conditional',
        when: '长线恩怨动机时',
        leaves: [
            { name: '复仇对象', definition: '他要报复的具体对象。不装：报复的理由（目标动机·表层想要）。' },
            { name: '报恩包袱', definition: '他要报答的那个人或那份恩情，以及这债压着他。不装：记账式的人情（关系网·人情债）。' },
            { name: '放不下的人', definition: '某个人他明明该放下却总想起。不装：恩怨的对象本身。' },
        ],
    },
    {
        name: '前史',
        tier: 'conditional',
        when: '有背景故事素材时',
        leaves: [
            { name: '童年关键', definition: '童年发生的、塑形的那一件事。不装：长大的环境（家庭出身·童年环境）。' },
            { name: '人生转折', definition: '成年阶段改变他走向的那一件事。不装：现在态（成长弧·现在态）。' },
            { name: '光辉事迹', definition: '他拿得出手的往事（一次救人、一次夺冠）。不装：别人传他的版本（声誉形象·圈内名声）。' },
            { name: '黑历史', definition: '他不愿被翻出来的往事。不装：法律上的案底（法律边缘·前科）。' },
            { name: '未解锁身世线索', definition: '身世里他自己还不知道的那一截。不装：已经确认的身世。' },
        ],
    },
    {
        name: '目标动机',
        tier: 'almost',
        hint: '想要与需要不一致时人最有戏',
        leaves: [
            { name: '表层想要', definition: '他嘴上说、近期在追的那个目标。不装：他真正缺什么（深层需要）。', skeleton: true },
            { name: '深层需要', definition: '他自己说不出、但驱动一切的那个内在匮乏（想被需要／想被认可／想逃）。不装：外来的要求（外部义务）。', skeleton: true },
            { name: '外部义务', definition: '家族、组织、债务、复仇等压在他身上的、不是他自己想的那个目标。不装：他内心认不认这个目标（深层需要）。' },
            { name: '受挫反应', definition: '目标受阻时他会怎么做（硬扛／换路／放弃）。不装：失败后的自我评价（自我认知·自我评价）。' },
        ],
    },
    {
        name: '成长弧',
        tier: 'conditional',
        when: '长线成长剧情时',
        leaves: [
            { name: '过去态', definition: '他从前是什么样的一条行为标签。不装：具体往事（前史）。' },
            { name: '现在态', definition: '他现在是什么样的一条行为标签。不装：现在态的成因（前史·人生转折）。' },
            { name: '可松动面', definition: '什么能让这条行为松一点、什么会让他改。不装：还没改完的部分（待解心结）。' },
            { name: '待解心结', definition: '他整个人还没解开的那个结。不装：他人之间的心结（既有关系·未说破的心结）。' },
        ],
    },
    {
        name: '戏点高光',
        tier: 'conditional',
        when: '用户点名魅力点或高光期待时',
        leaves: [
            { name: '名场面', definition: '他自己最拿得出手的那一场，一句概括。不装：光辉事迹（那是往事）。' },
            { name: '帅点萌点', definition: '他身上最吸引人的那个点，分条，各写方向。不装：日常性格（性格·核心矛盾）。' },
            { name: '经典台词', definition: '那句代表他的话。不装：口头禅（言谈习惯·口头禅）。' },
        ],
    },
    {
        name: '恋爱',
        tier: 'conditional',
        when: '素材或需求指向恋爱线时',
        hint: '性向面归 NSFW',
        behavior: true,
        leaves: [
            { name: '心动反应', definition: '见到心动对象时的可见反应。不装：不分对象的生理机制（身体反应·脸红体质）。' },
            { name: '被撩反应', definition: '被撩时接得住还是慌。不装：心动反应的起点。' },
            { name: '吃醋表现', definition: '吃醋时他会做什么。不装：占有欲的强度（情史依恋·占有欲）。' },
            { name: '亲近后相处', definition: '真正亲近之后两人怎么相处（日常形态）。不装：还没开始的阶段。' },
            { name: '会被什么打动', definition: '什么样的人或事会让他动心。不装：非人的偏好（喜恶·喜欢）。' },
        ],
    },
    {
        name: '情史依恋',
        tier: 'conditional',
        when: '恋爱线且有旧伤包袱时',
        behavior: true,
        leaves: [
            { name: '过往情史', definition: '过去的关系经历，一句。不装：他现在怎么看这段经历（恋爱观）。' },
            { name: '依恋类型', definition: '他的依恋模式（回避／焦虑／混乱）。不装：前任的具体信息（恋爱·心动反应）。' },
            { name: '关心人的方式', definition: '他怎么对在乎的人好（具体做法）。不装：亲近后的相处形态（恋爱·亲近后相处）。' },
            { name: '占有欲', definition: '占有欲的强度与表现边界。不装：吃醋的具体反应（恋爱·吃醋表现）。' },
            { name: '恋爱观', definition: '他对关系本身怎么看。不装：当前这段的具体状态。' },
        ],
    },
    {
        name: 'NSFW',
        tier: 'conditional',
        when: '用户需求或素材明确指向时',
        leaves: [
            { name: '性向', definition: '性吸引的指向。不装：恋爱线的情感状态（恋爱·心动反应）。' },
            { name: '经验程度', definition: '这方面有过多少经历。不装：具体经历细节。' },
            { name: '敏感点', definition: '哪些部位或哪种做法会让他有明显反应。不装：事后安抚（那是之后）。' },
            { name: '主导顺从倾向', definition: '在这件事里他偏主动还是偏配合、在哪些场合会切换。不装：性向。' },
            { name: '禁忌', definition: '这条线上明确不能碰的（会让他翻脸或停下）。不装：一般底线（底线雷区）。' },
            { name: '事后安抚', definition: '结束之后他会怎么把气氛和关系收回来。不装：对任何人的一般安抚手段（情绪光谱·有效安抚手段）。' },
        ],
    },
];

/**
 * 归属优先级对：同一类事实的两端叶，一对一。两端都写成「块·叶」——判据
 * 是按这个名比对档案里实际出现的叶，写裸块名的那一端永远匹配不上任何键，
 * 结构重复判定即对那几对永远静默。结构重复判定与生成契约共用这一份，两处
 * 各抄一份就会在改名后各判各的。
 *
 * 末三对的一端定名依据：旧清单里写的是裸块名（恩怨执念／恋爱／情史依恋），
 * 取名只用叶定义自身——「某个人他明明该放下却总想起」是恩怨执念这一块的
 * 核心母题，故取放不下的人；恋爱·亲近后相处与情史依恋·关心人的方式在叶
 * 定义里互相点名（前者被该块的肢体接触接受度、睡姿睡癖点名，后者被恋爱·
 * 亲近后相处点名），两者是同一组归属对。
 */
export const OWNERSHIP_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['底线雷区·绝不做的事', '底线雷区·行为禁区'],
    ['既有关系·专属称谓', '基本信息·别名与名号'],
    ['技能专长·技能盲区', '教育知识·知识盲区'],
    ['技能专长·技能盲区', '自我认知·认知盲区'],
    ['教育知识·知识盲区', '自我认知·认知盲区'],
    ['目标动机·外部义务', '目标动机·深层需要'],
    ['恩怨执念·放不下的人', '成长弧·待解心结'],
    ['恩怨执念·放不下的人', '既有关系·未说破的心结'],
    ['成长弧·待解心结', '既有关系·未说破的心结'],
    ['恋爱·亲近后相处', '情史依恋·关心人的方式'],
];

/** 是否回退骨架叶（模板叶没有骨架资格——它不是键名，回退骨架是键名集合）。 */
export function isSkeletonLeaf(leaf: CatalogLeaf | CatalogTemplateLeaf): leaf is CatalogLeaf {
    // 联合判别走 'name' in leaf：模板叶没有 name 字段，这是唯一能把它从
    // CatalogLeaf 里分出来的形态特征。写成类型断言会把不匹配推迟到运行期。
    return 'name' in leaf && leaf.skeleton === true;
}

/** 叶的成文：模板叶出模板声明，其余出键名；条件叶带方括号以免与声明叶名同形。 */
function leafTextOf(leaf: CatalogLeaf | CatalogTemplateLeaf): string {
    return 'template' in leaf ? leaf.template : leaf.name;
}

/**
 * 定义的成文：定义是接在叶名后的行内成分，压成单行——一个换行会把一行块
 * 拆成多行（破「渲染行数＝条目数」的判据），还可能凭空长出一个看起来像
 * 块行的行。定义由数据作者填成文字，进到这里本就该是一句话。入参只取
 * definition 字段，条件叶（不是叶对象、没有模板分支）因此也走同一条压行
 * 通道，不在自己的调用点上另开一条只 trim 的旁路。
 */
function definitionTextOf(leaf: { definition: string }): string {
    return leaf.definition.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * 定义段里的点名：普通叶出键名；模板叶出块名。模板叶没有键名，它那段模板串
 * 是「要模型展开的声明」而不是标识符，原样当点名会把这行重复一次，还会把
 * 模板串自带的分隔符字符混进定义段的起点（块行里那一位是「定义段从这儿开始」
 * 的唯一结构分隔符）。块名不带分隔符字符，又与块内叶名不同名，点名仍唯一。
 */
function definitionPrefixOf(block: CatalogBlock, leaf: CatalogLeaf | CatalogTemplateLeaf): string {
    return 'template' in leaf ? block.name : leaf.name;
}

/** 一块一行的清单成文：块名——叶串；叶数；档位（或块级条件限定语）（括注）｜定义段。 */
function renderBlockLine(block: CatalogBlock): string {
    const leaves = [
        ...block.leaves.map(leafTextOf),
        // 条件叶接在叶名串之后、叶数段之前：它是「挂了才出现」的一叶，
        // 排在叶数段之后会被读成声明叶数之外多出来的一叶。
        ...(block.optionalLeaf ? [`【${block.optionalLeaf.name}】`] : []),
    ];
    // 条件叶不占声明叶数（它是挂件），叶数段按 leaves.length 成文。
    const count = block.countText ?? `${block.leaves.length} 叶`;
    // conditional 档的档位位放的是块的成立条件限定语；其余两档出档位词。
    const tierWord = block.tier === 'conditional' ? block.when ?? '' : TIER_WORDS[block.tier];
    const hint = block.hint ? `（${block.hint}）` : '';
    // 定义段逐叶点名成文（模型读不出「第 N 个」对应哪个叶，块内叶名唯一，
    // 点名才无歧义）；没有定义的叶不出现在这一段，空段连分隔符一起省掉。
    const defined: ReadonlyArray<readonly [string, string]> = [
        ...block.leaves.map(leaf => [definitionPrefixOf(block, leaf), definitionTextOf(leaf)] as const),
        ...(block.optionalLeaf ? [[`【${block.optionalLeaf.name}】`, definitionTextOf(block.optionalLeaf)] as const] : []),
    ];
    const definitions = defined
        .filter(([, definition]) => definition)
        .map(([name, definition]) => `${name}：${definition}`);
    const definitionSection = definitions.length ? `｜${definitions.join('；')}` : '';
    return `${block.name}——${leaves.join('/')}；${count}；${tierWord}${hint}${definitionSection}`;
}

/** 策展清单全文（一块一行）：成文进策展指令的 reference_modules 段。 */
export function renderCatalog(): string {
    return PERSONA_BLOCK_CATALOG.map(renderBlockLine).join('\n');
}

/**
 * 回退骨架全文（策展失败时退回的最小块集）：块顺序＝目录顺序，取带
 * skeleton 标记的叶，值留空。纯静态骨架，不含任何宏占位符。
 */
export function renderSkeletonYaml(): string {
    return PERSONA_BLOCK_CATALOG
        .filter(block => block.leaves.some(isSkeletonLeaf))
        .map(block => [
            `${block.name}:`,
            ...block.leaves.filter(isSkeletonLeaf).map(leaf => `  ${leaf.name}:`),
        ].join('\n'))
        .join('\n');
}
