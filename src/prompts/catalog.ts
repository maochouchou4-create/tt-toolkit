/**
 * 人设策展目录（数据层）：策展清单与回退骨架背后的唯一真相源——块名、
 * 档位、每叶的键名与边界定义、哪些叶属于回退骨架。清单文本由它渲染成文，
 * 提示词正文与生成链不再另抄一份（同一个事实写在两处，改一处忘另一处
 * 就是这两份悄悄漂移）。
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
    leaves: ReadonlyArray<CatalogLeaf | CatalogTemplateLeaf>;
}

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
 * 渲染函数。定义段（叶定义）与可选叶当前全为空——字段与渲染分支已就位，
 * 填上内容自动生效。
 */
export const PERSONA_BLOCK_CATALOG: ReadonlyArray<CatalogBlock> = [
    {
        name: '基本信息',
        tier: 'almost',
        leaves: [{ name: '年龄', definition: '', skeleton: true }, { name: '性别', definition: '', skeleton: true }, { name: '身份', definition: '', skeleton: true }, { name: '别名与名号', definition: '', skeleton: true }],
    },
    {
        name: '外貌',
        tier: 'almost',
        leaves: [{ name: '整体印象', definition: '', skeleton: true }, { name: '标志性特征', definition: '', skeleton: true }, { name: '形体细节', definition: '', skeleton: true }],
    },
    {
        name: '性格',
        tier: 'almost',
        hint: '可附类型学速记叶',
        leaves: [{ name: '核心矛盾', definition: '', skeleton: true }, { name: '情绪反应', definition: '', skeleton: true }, { name: '说话风格', definition: '', skeleton: true }, { name: '待人差异', definition: '', skeleton: true }],
    },
    {
        name: '状态机',
        tier: 'conditional',
        when: '行为或人格反差时',
        countText: '≤4 态',
        leaves: [{ template: '各态（概述＋行为特征＋切换触发）', definition: '' }],
    },
    {
        name: '情绪光谱',
        tier: 'conditional',
        when: '需要读空气或哄人戏时',
        leaves: [{ name: '情绪外露程度', definition: '', skeleton: true }, { name: '生气外显信号', definition: '', skeleton: true }, { name: '有效安抚手段', definition: '', skeleton: true }, { name: '笑点哭点', definition: '', skeleton: true }],
    },
    {
        name: '自我认知',
        tier: 'common',
        hint: '破防与洞察戏的基座',
        leaves: [{ name: '自我评价', definition: '', skeleton: true }, { name: '他人眼中形象', definition: '', skeleton: true }, { name: '认知盲区', definition: '', skeleton: true }],
    },
    {
        name: '耻感与面子',
        tier: 'conditional',
        when: '调戏羞辱当众桥段指向时',
        leaves: [{ name: '羞耻触发点', definition: '' }, { name: '面子敏感度', definition: '' }, { name: '当众出丑反应', definition: '' }],
    },
    {
        name: '恐惧软肋',
        tier: 'conditional',
        when: '恐吓或保护戏指向时',
        leaves: [{ name: '最深恐惧', definition: '', skeleton: true }, { name: '软肋人或物', definition: '', skeleton: true }, { name: '会失态的威胁方式', definition: '', skeleton: true }],
    },
    {
        name: '底线雷区',
        tier: 'common',
        leaves: [{ name: '绝不做的事', definition: '', skeleton: true }, { name: '道德底线', definition: '', skeleton: true }, { name: '禁触话题', definition: '' }],
    },
    {
        name: '价值观信念',
        tier: 'conditional',
        when: '两难抉择指向时',
        hint: '阵营归此',
        leaves: [{ name: '道德观', definition: '' }, { name: '信仰立场', definition: '' }, { name: '金钱与人命排序', definition: '' }],
    },
    {
        name: '创伤档案',
        tier: 'conditional',
        when: '背景有阴影素材时',
        leaves: [{ name: '创伤事件', definition: '' }, { name: '信念伤疤', definition: '' }, { name: '触发情境', definition: '' }, { name: '未愈合部分', definition: '' }],
    },
    {
        name: '心理防御',
        tier: 'conditional',
        when: '高压突发场面指向时',
        leaves: [{ name: '战逃僵讨好', definition: '' }, { name: '危机优先级', definition: '' }, { name: '求援习惯', definition: '' }],
    },
    {
        name: '社交风格',
        tier: 'conditional',
        when: '群像或初见戏指向时',
        leaves: [{ name: '社交能量', definition: '' }, { name: '对陌生人默认态度', definition: '' }, { name: '幽默类型', definition: '' }, { name: '群体角色', definition: '' }],
    },
    {
        name: '教养礼仪',
        tier: 'conditional',
        when: '阶层反差题材时',
        leaves: [{ name: '礼仪习惯', definition: '' }, { name: '阶层烙印', definition: '' }, { name: '对上下位者态度差', definition: '' }],
    },
    {
        name: '称呼偏好',
        tier: 'conditional',
        when: '多 NPC 场合或改口戏时',
        leaves: [{ name: '喜欢的称呼', definition: '' }, { name: '讨厌的称呼', definition: '' }, { name: '外号来历', definition: '' }],
    },
    {
        name: '人际边界',
        tier: 'conditional',
        when: '慢热或距离感描写指向时',
        leaves: [{ name: '肢体接触接受度', definition: '' }, { name: '交友门槛', definition: '' }, { name: '社交距离感', definition: '' }],
    },
    {
        name: '言谈习惯',
        tier: 'common',
        hint: '说话味道的一致性',
        leaves: [{ name: '口头禅', definition: '', skeleton: true }, { name: '语气词', definition: '', skeleton: true }, { name: '敬语粗口', definition: '' }, { name: '口音方言', definition: '' }, { name: '语言能力', definition: '' }],
    },
    {
        name: '声音气息',
        tier: 'conditional',
        when: '贴近戏或气味识人题材时',
        leaves: [{ name: '声线音色', definition: '' }, { name: '音量语速', definition: '' }, { name: '体温气息', definition: '' }],
    },
    {
        name: '年龄错位',
        tier: 'conditional',
        when: '精灵吸血鬼重生者设定时',
        leaves: [{ name: '外表年龄', definition: '' }, { name: '实际年龄', definition: '' }, { name: '长寿带来的心态', definition: '' }],
    },
    {
        name: '性别表达',
        tier: 'conditional',
        when: '性别伪装类张力戏时',
        leaves: [{ name: '性别认同', definition: '' }, { name: '气质表达', definition: '' }, { name: '伪装与暴露风险', definition: '' }],
    },
    {
        name: '家庭出身',
        tier: 'conditional',
        when: '家族戏或原生家庭题材时',
        leaves: [{ name: '父母手足', definition: '' }, { name: '门第阶层', definition: '' }, { name: '家族义务或诅咒', definition: '' }, { name: '童年环境', definition: '' }],
    },
    {
        name: '关系网',
        tier: 'conditional',
        when: '旧识登场或背景调查指向时',
        leaves: [{ name: '挚友', definition: '' }, { name: '宿敌', definition: '' }, { name: '恩人仇家', definition: '' }, { name: '人情债', definition: '' }],
    },
    {
        name: '既有关系',
        tier: 'conditional',
        when: '熟人开局卡',
        hint: '青梅竹马/前恋人/宿敌',
        leaves: [{ name: '与对方角色的历史关系', definition: '' }, { name: '专属称谓', definition: '' }, { name: '共同经历', definition: '' }, { name: '未说破的心结', definition: '' }],
    },
    {
        name: '组织归属',
        tier: 'conditional',
        when: '身份带来便利与麻烦时',
        leaves: [{ name: '所属组织与职位', definition: '' }, { name: '师承同门', definition: '' }, { name: '组织义务与树敌', definition: '' }],
    },
    {
        name: '技能专长',
        tier: 'common',
        hint: '「明确不会什么」与「会什么」同重要',
        leaves: [{ name: '专业技能', definition: '', skeleton: true }, { name: '特殊天赋', definition: '' }, { name: '水平对标', definition: '' }, { name: '技能盲区', definition: '', skeleton: true }],
    },
    {
        name: '战斗风格',
        tier: 'conditional',
        when: '动手戏题材时',
        leaves: [{ name: '武器偏好', definition: '' }, { name: '战斗哲学', definition: '' }, { name: '杀伤意志', definition: '' }, { name: '战力对标', definition: '' }],
    },
    {
        name: '职业经济',
        tier: 'conditional',
        // 此处的「常选」二字是照抄现行清单的结果、不是本块档位位的表达：它被
        // 写进了 conditional 块的 when 里，等于档位词面在这块出现了第二份，而
        // 档位位在别处只由 TIER_WORDS 单点成文。清单改成数据时保留原样是为让
        // 渲染文本逐字不变；内容重整时它按档位口径收口为「现代都市题材」。
        when: '现代都市题材常选',
        hint: '职场身份归此',
        leaves: [{ name: '职业', definition: '' }, { name: '收入档位', definition: '' }, { name: '消费习惯', definition: '' }, { name: '金钱观', definition: '' }],
    },
    {
        name: '教育知识',
        tier: 'conditional',
        when: '交谈可信度重要时',
        hint: '校园身份归此',
        leaves: [{ name: '学历师承', definition: '' }, { name: '知识强项', definition: '' }, { name: '知识盲区', definition: '' }, { name: '专业用语', definition: '' }],
    },
    {
        name: '生活自理',
        tier: 'conditional',
        when: '同居日常或野外剧情时',
        leaves: [{ name: '厨艺家务', definition: '' }, { name: '驾驶骑术', definition: '' }, { name: '生存技能', definition: '' }],
    },
    {
        name: '健康体质',
        tier: 'conditional',
        when: '病弱照顾或体能限制指向时',
        leaves: [{ name: '体能', definition: '' }, { name: '慢性旧伤', definition: '' }, { name: '过敏用药', definition: '' }, { name: '病中表现', definition: '' }, { name: '感官锐钝', definition: '' }],
    },
    {
        name: '身体反应',
        tier: 'conditional',
        when: '受伤饮酒或身体诚实桥段时',
        leaves: [{ name: '忍痛阈值', definition: '' }, { name: '脸红体质', definition: '' }, { name: '流泪点', definition: '' }, { name: '酒量醉态', definition: '' }],
    },
    {
        name: '睡眠与梦',
        tier: 'conditional',
        when: '同床或噩梦安抚戏指向时',
        leaves: [{ name: '睡眠质量', definition: '' }, { name: '失眠诱因', definition: '' }, { name: '睡姿睡癖', definition: '' }, { name: '梦话噩梦', definition: '' }],
    },
    {
        name: '饮食禁忌',
        tier: 'conditional',
        when: '宴席投喂桥段指向时',
        leaves: [{ name: '口味偏好', definition: '' }, { name: '忌口', definition: '' }, { name: '宗教种族禁忌', definition: '' }],
    },
    {
        name: '喜恶',
        tier: 'almost',
        leaves: [{ name: '喜欢', definition: '', skeleton: true }, { name: '讨厌', definition: '', skeleton: true }, { name: '雷点', definition: '', skeleton: true }],
    },
    {
        name: '兴趣嗜好',
        tier: 'conditional',
        when: '日常戏或约会选题时',
        leaves: [{ name: '爱好', definition: '' }, { name: '消遣方式', definition: '' }],
    },
    {
        name: '作息怪癖',
        tier: 'conditional',
        when: '偶遇蹲点与细节辨识戏时',
        leaves: [{ name: '作息与出行规律', definition: '' }, { name: '居住环境', definition: '' }, { name: '标志性小动作', definition: '' }],
    },
    {
        name: '随身物品',
        tier: 'conditional',
        when: '搜身借用桥段指向时',
        leaves: [{ name: '出门必带', definition: '' }, { name: '口袋里有什么', definition: '' }, { name: '常用工具', definition: '' }],
    },
    {
        name: '重要所有物',
        tier: 'conditional',
        when: '物品钩子剧情时',
        leaves: [{ name: '传家信物与来历', definition: '' }, { name: '贵重资产', definition: '' }, { name: '拼命保护的东西', definition: '' }],
    },
    {
        name: '宠物伴生',
        tier: 'conditional',
        when: '伴生生物参与场景时',
        leaves: [{ name: '宠物契约兽', definition: '' }, { name: '其能力脾气', definition: '' }, { name: '与 User 默契', definition: '' }],
    },
    {
        name: '数字身份',
        tier: 'conditional',
        when: '网恋掉马或人肉搜索题材时',
        leaves: [{ name: '账号矩阵', definition: '' }, { name: '匿名马甲', definition: '' }, { name: '数字足迹', definition: '' }, { name: '反追踪习惯', definition: '' }],
    },
    {
        name: '声誉形象',
        tier: 'conditional',
        when: 'NPC 初见预设立场重要时',
        leaves: [{ name: '圈内名声', definition: '' }, { name: '绰号传说', definition: '' }, { name: '公众认知与真实的落差', definition: '' }, { name: '圈层差异', definition: '' }],
    },
    {
        name: '权力地位',
        tier: 'conditional',
        when: '位分压迫戏时',
        hint: '宫廷位分归此',
        leaves: [{ name: '社会阶层', definition: '' }, { name: '权力来源', definition: '' }, { name: '追随者', definition: '' }, { name: '权力的代价', definition: '' }],
    },
    {
        name: '法律边缘',
        tier: 'conditional',
        when: '侦探律政或翻旧账剧情时',
        leaves: [{ name: '前科', definition: '' }, { name: '黑白人脉', definition: '' }, { name: '灰色手段', definition: '' }],
    },
    {
        name: '秘密马甲',
        tier: 'conditional',
        when: '掉马与双面人生题材时',
        leaves: [{ name: '隐藏身份', definition: '' }, { name: '秘密全貌', definition: '' }, { name: '知情者范围', definition: '' }, { name: '暴露风险', definition: '' }],
    },
    {
        name: '黑暗面',
        tier: 'conditional',
        when: '阴沉底色或黑化剧情时',
        leaves: [{ name: '阴暗念头', definition: '' }, { name: '暴力控制倾向', definition: '' }, { name: '成瘾物', definition: '' }, { name: '最不堪的一面', definition: '' }],
    },
    {
        name: '说谎识谎',
        tier: 'conditional',
        when: '审讯试探攻防指向时',
        leaves: [{ name: '撒谎能力与破绽', definition: '' }, { name: '识谎能力', definition: '' }, { name: '被质疑反应', definition: '' }],
    },
    {
        name: '把柄操纵',
        tier: 'conditional',
        when: '反派设局剧情时',
        leaves: [{ name: '会被什么诱惑', definition: '' }, { name: '轻信谁', definition: '' }, { name: '致命把柄', definition: '' }],
    },
    {
        name: '恩怨执念',
        tier: 'conditional',
        when: '长线恩怨动机时',
        leaves: [{ name: '复仇对象', definition: '' }, { name: '报恩包袱', definition: '' }, { name: '放不下的人', definition: '' }],
    },
    {
        name: '前史',
        tier: 'conditional',
        when: '有背景故事素材时',
        leaves: [{ name: '童年关键', definition: '' }, { name: '人生转折', definition: '' }, { name: '光辉事迹', definition: '' }, { name: '黑历史', definition: '', skeleton: true }, { name: '未解锁身世线索', definition: '' }],
    },
    {
        name: '目标动机',
        tier: 'almost',
        hint: '想要与需要不一致时人最有戏',
        leaves: [{ name: '表层想要', definition: '', skeleton: true }, { name: '深层需要', definition: '', skeleton: true }, { name: '第一驱动力', definition: '', skeleton: true }, { name: '受挫反应', definition: '' }],
    },
    {
        name: '成长弧',
        tier: 'conditional',
        when: '长线成长剧情时',
        leaves: [{ name: '过去态', definition: '' }, { name: '现在态', definition: '' }, { name: '可松动面', definition: '' }, { name: '待解心结', definition: '' }],
    },
    {
        name: '戏点高光',
        tier: 'conditional',
        when: '用户点名魅力点或高光期待时',
        leaves: [{ name: '名场面', definition: '' }, { name: '帅点萌点', definition: '' }, { name: '经典台词', definition: '' }],
    },
    {
        name: '恋爱',
        tier: 'conditional',
        when: '素材或需求指向恋爱线时',
        hint: '性向面归 NSFW',
        leaves: [{ name: '心动反应', definition: '' }, { name: '被撩反应', definition: '' }, { name: '吃醋表现', definition: '' }, { name: '亲近后相处', definition: '' }, { name: '会被什么打动', definition: '' }],
    },
    {
        name: '情史依恋',
        tier: 'conditional',
        when: '恋爱线且有旧伤包袱时',
        leaves: [{ name: '过往情史', definition: '' }, { name: '依恋类型', definition: '' }, { name: '关心人的方式', definition: '' }, { name: '占有欲', definition: '' }, { name: '恋爱观', definition: '' }],
    },
    {
        name: 'NSFW',
        tier: 'conditional',
        when: '用户需求或素材明确指向时',
        leaves: [{ name: '性向', definition: '' }, { name: '经验程度', definition: '' }, { name: '敏感点', definition: '' }, { name: '主导顺从倾向', definition: '' }, { name: '禁忌', definition: '' }, { name: '事后安抚', definition: '' }],
    },
];

/**
 * 归属优先级对：同一类事实的两端叶，一对一。结构重复判定与生成契约共用
 * 这一份，两处各抄一份就会在改名后各判各的。数据在内容重整时随目录一起
 * 落进本文件；在那之前是空表——空表让「没有归属对可判」成为事实，而不是
 * 让人以为已经判过了。
 */
export const OWNERSHIP_PAIRS: ReadonlyArray<readonly [string, string]> = [];

/** 是否回退骨架叶（模板叶没有骨架资格——它不是键名，回退骨架是键名集合）。 */
export function isSkeletonLeaf(leaf: CatalogLeaf | CatalogTemplateLeaf): leaf is CatalogLeaf {
    // 联合判别走 'name' in leaf：模板叶没有 name 字段，这是唯一能把它从
    // CatalogLeaf 里分出来的形态特征。写成类型断言会把不匹配推迟到运行期。
    return 'name' in leaf && leaf.skeleton === true;
}

/** 叶的成文：模板叶出模板声明，其余出键名；定义了边界的一并在定义段成文（见 renderCatalog 的定义段）。 */
function leafTextOf(leaf: CatalogLeaf | CatalogTemplateLeaf): string {
    return 'template' in leaf ? leaf.template : leaf.name;
}

/**
 * 定义的成文：定义是接在叶名后的行内成分，压成单行——一个换行会把一行块
 * 拆成多行（破「渲染行数＝条目数」的判据），还可能凭空长出一个看起来像
 * 块行的行。定义由数据作者填成文字，进到这里本就该是一句话。
 */
function definitionTextOf(leaf: CatalogLeaf | CatalogTemplateLeaf): string {
    return leaf.definition.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** 一块一行的清单成文：块名——叶串；叶数；档位（或块级条件限定语）（括注）｜定义段。 */
function renderBlockLine(block: CatalogBlock): string {
    const leaves = block.leaves.map(leafTextOf);
    const count = block.countText ?? `${block.leaves.length} 叶`;
    // conditional 档的档位位放的是块的成立条件限定语；其余两档出档位词。
    const tierWord = block.tier === 'conditional' ? block.when ?? '' : TIER_WORDS[block.tier];
    const hint = block.hint ? `（${block.hint}）` : '';
    // 定义段逐叶点名成文（模型读不出「第 N 个」对应哪个叶，块内叶名唯一，
    // 点名才无歧义）；没有定义的叶不出现在这一段，空段连分隔符一起省掉。
    const definitions = block.leaves
        .map(leaf => [leafTextOf(leaf), definitionTextOf(leaf)] as const)
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
