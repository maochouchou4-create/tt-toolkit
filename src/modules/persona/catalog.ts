/**
 * 人设策展目录（数据层）：策展清单与回退骨架背后的唯一真相源——块名、
 * 档位、每叶的键名与边界定义、哪些叶属于回退骨架、同一类事实归属哪一叶。
 * 清单文本由它渲染成文，提示词正文与生成链不再另抄一份（同一个事实写在
 * 两处，改一处忘另一处就是这两份悄悄漂移）。
 *
 * 本文件只做数据与纯渲染：不 import 业务模块，也不得反向 import persona
 * 域其他模块——那条边才是成环入口。消费方一律从本叶子文件导入：persona
 * barrel 会 re-export 冒烟与生成链，经它取会把整条链拉进消费方的初始化链
 * 并形成环状导入（catalog 自身零 import 只证明它自己不成环，不证明这条
 * 取法不成环）。
 */

/** 目录里的普通叶：键名 ＋ 边界定义 ＋ 是否属于回退骨架。 */
export interface CatalogLeaf {
    name: string;
    /** 叶的边界定义（谁的、装什么、明确不装什么）。空串＝该叶还没有定义——渲染时不出现这段，填上即自动生效。 */
    definition: string;
    /** 回退骨架成员。标记打在叶上而不是块上：块级标记会把「只差几叶」的整块毙掉。 */
    skeleton?: true;
}

export interface CatalogBlock {
    name: string;
    /** 档位：almost＝几乎必选／common＝常选／conditional＝按 when 的成立条件入选。 */
    tier: 'almost' | 'common' | 'conditional';
    /** 块级条件限定语：conditional 档成文在行末（它就是那一档的「档位词」位），其余档留空。 */
    when?: string;
    /** 括号内的归类说明，成文为行末的（hint）。 */
    hint?: string;
    /** 块内的叶。 */
    leaves: ReadonlyArray<CatalogLeaf>;
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
 *     位，「档位词面」在同一行出现第二份，档位口径即不再单点。
 *
 * 机判现状：这两条只被策展清单的整段文本快照顺带锁住——快照锁的是成文结果
 * 而非这两个字段本身（写错会改动那一行文本而翻红，但字段的取值本身不另作比对）。
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
 * 档案段的两个派生段的开闭标签，与策展清单段同款理由（两边各写一份字面量
 * 就会漂成对不上的段切分）：
 *   - 边界定义段：叶的「不装」半句，与策展清单段的定义段同源不同裁；
 *   - 归属优先级段：OWNERSHIP_PAIRS 的成文。
 */
export const CATALOG_DEFINITIONS_OPEN_TAG = '<catalog_definitions>';
export const CATALOG_DEFINITIONS_CLOSE_TAG = '</catalog_definitions>';
export const OWNERSHIP_TABLE_OPEN_TAG = '<ownership_priority_table>';
export const OWNERSHIP_TABLE_CLOSE_TAG = '</ownership_priority_table>';

/**
 * 策展目录数据（锚点目录）：目录定义「一张自设卡该有哪些锚」，不定义传记
 * 字段——每叶的存在理由都是「模型推不出来、又每轮用得上」。可推导的维度
 * （情绪反应、待人差异一类）刻意不给位置：它们在扮演现场从核心矛盾推出来，
 * 写进卡里只是稀释。世界特有机制不进这张表，走机制挂载（策展指令的开放段）。
 *
 * 块头四段（块名／叶数／档位或块级条件限定语／括号归类说明）与叶行成文
 * 格式都由 renderCatalog 拆字段落实，改词面改这里即可，不必改渲染函数。
 * 定义段（叶定义）逐叶成文接在行末——策展模型看不到没被渲染的东西，定义
 * 只存在代码里等于对模型零作用。
 */
export const PERSONA_BLOCK_CATALOG: ReadonlyArray<CatalogBlock> = [
    {
        name: '基本信息',
        tier: 'almost',
        leaves: [
            { name: '身份定位', definition: '一句话身份——他是谁、在哪个世界、站在什么位置（如「十二岁储君，母后被囚后由他代理朝政」）。不装：家谱全录、组织架构、世界书已载的世界规则。', skeleton: true },
            { name: '别名与名号', definition: '绰号、代号、尊称、自称——一顶多的叫法清单。不装：只对某个特定人物用的专属叫法（归「既有关系·专属称谓」）、只出现一次的临时称呼。', skeleton: true },
        ],
    },
    {
        name: '外貌',
        tier: 'almost',
        leaves: [
            { name: '整体印象', definition: '2～4 个能被认出来的强特征（身高体态、气场、最打眼的记号），写「在场面里怎么被看见」。不装：全身照式流水账、他人评价、与「辨识标记」重复的记号。', skeleton: true },
            { name: '辨识标记', definition: '一认就中的独有记号——疤、瞳色、异肢、气味、嗓音。不装：与剧情绑定的临时伤妆、可从「整体印象」推出的泛写。', skeleton: true },
        ],
    },
    {
        name: '性格',
        tier: 'almost',
        hint: '可附类型学速记',
        behavior: true,
        leaves: [
            { name: '核心矛盾', definition: '2～4 条互相拉扯的行为向标签——每条自带「对什么硬/吃什么/护什么」，条与条方向不同，张力即立体；全卡最重的一行。不装：同义堆叠、四字评语连串、谁都适用的泛性格。', skeleton: true },
        ],
        optionalLeaf: { name: '类型学速记', definition: '用户给出 MBTI／九型结果时原样抄录。不装：自行测猜的结果。' },
    },
    {
        name: '言谈习惯',
        tier: 'almost',
        behavior: true,
        leaves: [
            { name: '口头禅与语气词', definition: '高频口头禅、语气词、口吃结巴——听得见的语言记号。不装：只出现一次的台词、书面语描述。', skeleton: true },
            { name: '说话方式', definition: '怎么说话——语速、句长、敬语或糙话、对谁省话对谁话痨（行为向标签）。不装：嗓音音色（归「外貌·辨识标记」）、情境台词。', skeleton: true },
        ],
    },
    {
        name: '底线雷区',
        tier: 'common',
        behavior: true,
        leaves: [
            { name: '绝不做的事', definition: '他自己绝不会去做的——无论代价。不装：人人都不会做的法律常识、与「行为禁区」同素材的换皮复述。', skeleton: true },
            { name: '行为禁区', definition: '别人对他做不得的——踩线即翻脸或冷掉。不装：与「绝不做的事」同素材复述。', skeleton: true },
            { name: '禁触话题', definition: '一提就僵、就炸、就岔开的话题清单。不装：可从「核心矛盾」直接推出的泛化敏感。', skeleton: true },
        ],
    },
    {
        name: '目标动机',
        tier: 'almost',
        leaves: [
            { name: '外部义务', definition: '压在他身上的外部要求——职责、契约、他人期待。不装：他人自己的动机。', skeleton: true },
            { name: '深层需要', definition: '他自己内心真正想要的——与外部义务相反时张力最好。不装：剧情目标与阶段性任务，那些归剧情层承担。', skeleton: true },
        ],
    },
    {
        name: '恋爱',
        tier: 'conditional',
        when: '恋爱线或亲密戏在需求或素材中成立时',
        behavior: true,
        leaves: [
            { name: '心动反应', definition: '动心时怎么看得出来——行为、语言、生理反应的方向。不装：择偶标准清单、对特定角色的好感度——好感进展归剧情层承担。' },
            { name: '亲密形态', definition: '关系确立后他什么样——黏人度、吃醋方式、亲密时的边界。不装：情史流水账、对前度的叙述——那些归剧情与世界书。' },
        ],
    },
    {
        name: 'NSFW',
        tier: 'conditional',
        when: '需求或素材明确涉及成人内容时',
        behavior: true,
        leaves: [
            { name: '身体反应', definition: '敏感点、生理反应方向。不装：与情节绑定的具体场面。' },
            { name: '边界与偏好', definition: '硬界限（绝不）＋喜好方向。不装：可从「底线雷区」推出的重复条目。' },
        ],
    },
    {
        name: '既有关系',
        tier: 'conditional',
        when: '素材含与开场人物的既有关系时',
        leaves: [
            { name: '专属称谓', definition: '他对特定在场人物的专属叫法＋对方是谁。不装：对任何人都通用的叫法（归「基本信息·别名与名号」）。' },
            { name: '相处基调', definition: '与该人物之间的历史默契、未说破的事、相处惯性。不装：对方人物的背景，那些归世界书。' },
        ],
    },
];

/**
 * 归属优先级对：同一类事实的两端叶，一对一。两端都写成「块·叶」——判据
 * 是按这个名比对档案里实际出现的叶，写裸块名的那一端永远匹配不上任何键，
 * 结构重复判定即对那几对永远静默。结构重复判定与生成契约共用这一份，两处
 * 各抄一份就会在改名后各判各的。
 *
 * 收窄依据：归属对只收「两端叶都存活、且叶定义互相点名」的混淆面。旧表
 * 十对里七对的一端随锚点目录退役；现存的混淆面只有四组——底线三分同素材、
 * 称谓两档、外貌两叶、目标动机两叶（后两对的叶定义互相点名）。
 */
export const OWNERSHIP_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['底线雷区·绝不做的事', '底线雷区·行为禁区'],
    ['既有关系·专属称谓', '基本信息·别名与名号'],
    ['外貌·整体印象', '外貌·辨识标记'],
    ['目标动机·外部义务', '目标动机·深层需要'],
];

/** 是否回退骨架叶：骨架标记打在叶数据上，判据只认这个标记。 */
export function isSkeletonLeaf(leaf: CatalogLeaf): boolean {
    return leaf.skeleton === true;
}

/**
 * 定义的成文：定义是接在叶名后的行内成分，压成单行——一个换行会把一行块
 * 拆成多行（破「渲染行数＝条目数」的判据），还可能凭空长出一个看起来像
 * 块行的行。定义由数据作者填成文字，进到这里本就该是一句话。入参只取
 * definition 字段，条件叶（不是叶对象）因此也走同一条压行通道，不在自己的
 * 调用点上另开一条只 trim 的旁路。
 */
function definitionTextOf(leaf: { definition: string }): string {
    return leaf.definition.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** 一块一行的清单成文：块名——叶串；叶数；档位（或块级条件限定语）（括注）｜定义段。 */
function renderBlockLine(block: CatalogBlock): string {
    const leaves = [
        ...block.leaves.map(leaf => leaf.name),
        // 条件叶接在叶名串之后、叶数段之前：它是「挂了才出现」的一叶，
        // 排在叶数段之后会被读成声明叶数之外多出来的一叶。
        ...(block.optionalLeaf ? [`【${block.optionalLeaf.name}】`] : []),
    ];
    // 条件叶不占声明叶数（它是挂件），叶数段按 leaves.length 成文。
    const count = `${block.leaves.length} 叶`;
    // conditional 档的档位位放的是块的成立条件限定语；其余两档出档位词。
    const tierWord = block.tier === 'conditional' ? block.when ?? '' : TIER_WORDS[block.tier];
    const hint = block.hint ? `（${block.hint}）` : '';
    // 定义段逐叶点名成文（模型读不出「第 N 个」对应哪个叶，块内叶名唯一，
    // 点名才无歧义）；没有定义的叶不出现在这一段，空段连分隔符一起省掉。
    const defined: ReadonlyArray<readonly [string, string]> = [
        ...block.leaves.map(leaf => [leaf.name, definitionTextOf(leaf)] as const),
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
 * 叶定义里的排除半句分隔符：「装什么」与「不装什么」两半句靠它分开。
 * 档案段的定义段只取后半句——策展段选块要靠「装什么」，档案段填值时
 * schema 已经是策展段裁好的键，它要守的只有「别把什么也塞进来」。
 */
const EXCLUSION_MARK = '不装：';

/**
 * 没有排除半句时的兜底成文：本批目录数据里不该出现，冒烟按 0 判。真出现
 * 了（新增叶时漏写「不装：」）这里给出的是一句可执行的边界指令，而不是空行
 * 或半个定义句。它随档案段正文出厂（万一触发即是给用户看的正文），所以对外
 * 导出给冒烟当期望值用——冒烟另抄一份就是在断言一份可能已改口的字符串。
 */
export const NO_EXCLUSION_TEXT = '按 definition 边界写，别越界';

/**
 * 排除半句的成文：先走 definitionTextOf 的同一条单行化通道再切分，另写一套
 * 解析就会在定义里出现换行时切成两半。切的是数据里那一处分隔符，判定与成文
 * 同源不构成问题（这一段只有一份数据可切）。
 */
function exclusionTextOf(leaf: { definition: string }): string {
    const definition = definitionTextOf(leaf);
    const at = definition.indexOf(EXCLUSION_MARK);
    return at < 0 ? '' : definition.slice(at + EXCLUSION_MARK.length).trim();
}

/**
 * 档案段叶边界定义段的段头说明行：这一段是什么、怎么读、作用域多大。落在
 * 渲染函数里而不落调用方正文——放调用方就等于把段头排除在「整段逐字节」那条
 * 锁之外，那条锁是本段唯一的同源保证，段头漏改/被改都不会翻红。
 *
 * 段头不许出现「下方」「上面」「以上」这类对版面的位置指代：归属表挪个位置
 * 它就成假话，而没有断言会翻红。要指就指名道姓写「归属优先级表」（表标题的
 * 成文名，全档只此一个叫法）。
 */
const CATALOG_DEFINITIONS_HEADER = '[下面是本次 schema 里每个叶子键的边界——只出「这个键不装什么」。schema 里没有的键一律不输出。同一类事实按「归属优先级表」只写进一端，别处不重复叙述。]';

/**
 * 叶边界段一行：定位键＋成文。
 */
function definitionRow(block: CatalogBlock, leaf: { name: string; definition: string }): { key: string; line: string } {
    const key = `${block.name}·${leaf.name}`;
    return { key, line: `${key}：${exclusionTextOf(leaf) || NO_EXCLUSION_TEXT}` };
}

/**
 * 档案段的叶边界定义段（段头一行＋一叶一行）：行首「块名·叶名」定位到具体
 * 键，行身是该叶的排除半句。与策展清单段的定义段同源不同裁，两处都是
 * renderCatalog 的上游——各抄一份就会在叶定义改字时各说各的。
 *
 * 条件叶（optionalLeaf）同样出行：它有边界要守。它虽不占声明叶数、挂不挂
 * 全看用户有没有给类型学测试结果，但策展段真给出结果时这个键就会出现在
 * <target_schema> 里——档案段拿不到任何边界提示，只能照要求 4「绝不留空」
 * 硬编，而模型写这类叶的惯性正是补一段类型学常识科普。
 *
 * 键集参数＝随请求收敛的开关（见 definitionRowKeysFromSchema）：档案段要守
 * 的只有本次 schema 里那几个键的边界，全量里大半是本次不可能出现的键，
 * 且体积随目录单调增长永不回落。不传＝全量（策展失败回退默认模板、以及冒烟
 * 的静态形态都走这条）。
 *
 * 过滤后零行时回落全量：schema 与目录毫无交集（策展整份挂了机制挂载块之类）
 * 时出「只有段头没有一行」的段，等于把本段要防的「模型拿不到边界」原样放行，
 * 那时宁可多给一屏边界。
 */
export function renderCatalogDefinitions(keys?: ReadonlySet<string>): string {
    const rows = PERSONA_BLOCK_CATALOG.flatMap(block => [
        ...block.leaves.map(leaf => definitionRow(block, leaf)),
        ...(block.optionalLeaf ? [definitionRow(block, block.optionalLeaf)] : []),
    ]);
    const kept = keys ? rows.filter(row => keys.has(row.key)) : rows;
    return [
        CATALOG_DEFINITIONS_HEADER,
        ...(kept.length ? kept.map(row => row.line) : rows.map(row => row.line)),
    ].join('\n');
}

/**
 * 键名归一：`【…】` 只是一种成文包装，方括号里的才是键名。
 *
 * 归在这一层而不是各调用方各剥一次：条件叶在清单里以【…】成文、在档案里以裸
 * 键名成文，两处各剥各的就会在「哪边忘了剥」时静默对不上。
 */
export function catalogKeyName(raw: string): string {
    return raw.trim().replace(/^【(.+)】$/, '$1');
}

/**
 * 策展产出的 schema → 叶边界段的行键集（定义段的收敛口径逐字定死）：
 *   - 顶层块名进键集；
 *   - 两格缩进的叶名按「块名·叶名」进键集；
 *   - 【…】 形态的条件叶按方括号里的名字匹配（清单里它就以【…】成文）；
 *   - 缩进更深的子键不进键集——叶边界段一行对应一个块或一个叶子键，
 *     深层子键没有各自的目录定义。
 * 只读顶层块名与叶名就够了（策展段输出是本仓自产的固定形状，不引 YAML 解析
 * 库）；值侧一律丢弃。
 */
export function definitionRowKeysFromSchema(schema: string): ReadonlySet<string> {
    const keys = new Set<string>();
    let currentBlock = '';
    for (const raw of schema.split('\n')) {
        const indent = raw.length - raw.trimStart().length;
        const at = raw.search(/[:：]/);
        if (at < 0) continue;
        const name = catalogKeyName(raw.slice(indent, at));
        if (!name) continue;
        if (indent === 0) {
            currentBlock = name;
            keys.add(name);
        } else if (indent === 2 && currentBlock) {
            keys.add(`${currentBlock}·${name}`);
        }
    }
    return keys;
}

/**
 * 目录键集：目录里有哪几块、哪几叶（块名＋「块名·叶名」＋条件叶）。
 *
 * 这是「什么算档案叶」的唯一权威，解析层与判据层都从这里取，不各自重推——
 * 手抄一份键名规则的第二处在目录改名后会静默失效，而失效方向永远是少认。
 */
export function catalogKeySet(catalog: ReadonlyArray<CatalogBlock> = PERSONA_BLOCK_CATALOG): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const block of catalog) {
        keys.add(block.name);
        for (const leaf of block.leaves) {
            keys.add(`${block.name}·${catalogKeyName(leaf.name)}`);
        }
        if (block.optionalLeaf) {
            keys.add(`${block.name}·${catalogKeyName(block.optionalLeaf.name)}`);
        }
    }
    return keys;
}

/**
 * 归属优先级表的标题：表说「同一类事实只写进一端」，标题说清每行两端哪端该
 * 写——两者是一体的，标题必须与表体同处同源。标题落在调用方正文里就成了第二
 * 份手抄，改表不改标题时无从察觉。
 */
const OWNERSHIP_TABLE_TITLE = '归属优先级表（同一类事实只写进一端。每行＝该写的那一端 ｜ 同类事实里不该复述的那一端）';

/**
 * 归属优先级表成文（一行一对，成对顺序＝归属顺序）：档案段的规则说「按顺序
 * 走」，这张表是同一件事的「块·叶」对照，与规则共用 OWNERSHIP_PAIRS 一份数据。
 */
export function renderOwnershipTable(): string {
    return [
        OWNERSHIP_TABLE_TITLE,
        ...OWNERSHIP_PAIRS.map(([owner, other]) => `${owner} ｜ ${other}`),
    ].join('\n');
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
