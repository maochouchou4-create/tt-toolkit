/**
 * PersonaWeaver fork YAML 人设文本解析（纯函数）。
 *
 * MODIFICATIONS（相对上游 fork）：log.js 依赖改为静默容错（parse 失败返回
 * 空 Map，调用方按「不可解析」处理）——原 console.error 出口在 tab 内
 * 由调用方 toast 呈现。解析契约（顶层键切块、单顶层键整块去缩进）不变。
 *
 * **本文件有两条解析路径，块界定义各有一条，故意不同源**，往下读先认路：
 *   - **策展段那一路**（模型原始产出 → 策展骨架）：`parseYamlToBlocks` 切块 ＋
 *     `isSchemaSkeleton` 形状校验，两者共用 `isTopLevelKeyLine`（本文件上半，
 *     缩进 ≤1 算块界）。见该函数头注。
 *   - **档案段那一路**（已填满的档案 → 判据层的叶级输入）：`scanProfileLeaves`
 *     ＋ `checkProfileShape`（本文件下半「档案叶级解析与形状校验」段，缩进 0
 *     算块界、其余都是叶）。见该段头注。
 * 分家的理由、输入差异与取舍写在下半段那段头注里；改任何一条之前先读它。
 */

/**
 * 键行判定（切块用，宽松）：可缩进、键名不含空白/冒号/列表标记，冒号可
 * 全角或半角。parseYamlToBlocks 的两处内部判定共用本正则。
 *
 * 宽严分工（刻意不共用同一条）：本正则服务**切分**——它面对的是模型原始
 * 产出，宁可宽容（认得出块界）也不该因标点把内容整块丢掉；骨架**校验**
 * 用 SCHEMA_KEY_LINE_RE（严），服务闸门。两者判的都不是同一件事，禁为了
 * 「只有一处正则」把校验放宽到切分口径。
 */
const KEY_LINE_RE = /^\s*([^:\s\-]+?)\s*[:：]/;

/**
 * 键行判定（骨架校验用，从严）：键名必须是标识符样 token——排除子句标点
 * （中英文逗号句号问叹分号顿号、引号、省略号）。理由：散文句天然带这些
 * 标点，而 YAML 键名不会。「好的，以下是为你定制的骨架：」这类**散言前导**
 * 会被宽松版认成顶层键，进而在 prefill 派生里变成首键（事故换皮实证），
 * 从严版直接出局。
 */
const SCHEMA_KEY_LINE_RE = /^\s*([^\s\-:，。！？；、,.!?;…“”‘’"']+?)\s*[:：]/;

/** 无缩进行判定（行首即内容）。 */
const isUnindented = (line: string): boolean => line.search(/\S|$/) === 0;

/**
 * 剥可能残留的 yaml 围栏（三处解析口径共用一份）。
 *
 * 为什么提出来：围栏剥除是解析的前置，三处各抄一份正则就会在「围栏行自己带
 * 换行／模型补了 ```yaml 后缀」这类形态上各剥各的，同一份输入在不同消费方
 * 得到不同的键集合——而档案、schema 判据、叶级解析三者看的必须是同一段文本。
 */
function stripFence(text: string): string {
    return text.replace(/^```[a-z]*\n?/im, '').replace(/```$/im, '').trim();
}

/**
 * 切块边界判定（**策展段那一路的唯一定义**：`parseYamlToBlocks` 的开块与
 * `isSchemaSkeleton` 的「此行会开一个新块」都用它）——宽松键行、非列表项、
 * 缩进 ≤1。
 *
 * 为什么必须有这一处共同定义：两个消费方曾各自内联条件（切块写
 * `KEY_LINE_RE && indentLevel <= 1`、校验写「缩进行一律从宽」），于是
 * 「 备注，注意如下:」这类 1 空格缩进、键名带标点的行被判据放行、却被切块
 * 当成新顶层块——校验说「这是骨架」，切块给出的却不是它看到的形状。
 * 两边共用本函数后，「什么算块界」在这一路里只有一个答案。
 *
 * 缩进 ≤1（而非 ===0）是既有切块契约的容忍度：模型常用 1 空格缩进子键，
 * 按块界处理可把 schema 摊平；改动它会波及单顶层键去缩进修复，不在本处
 * 职责内。
 *
 * **不是全文件的唯一定义**：档案段那一路（`scanProfileLeaves`，见本文件下半
 * 「档案叶级解析与形状校验」段的块界说明）面对的是另一类输入、另一份契约，
 * 自带另一条块界定义（缩进 0 ＝ 块，其余缩进都是叶），**不调用本函数**。
 * 两条定义的分歧只在畸形输入上显形：策展产出过了骨架判据、叶就是两格缩进，
 * 此时两条定义一致；而档案段宁可宽松读也不要零叶。理由与取舍写在那边，
 * 改任何一条之前先读那一段——本条只管策展段。
 */
function isTopLevelKeyLine(line: string): boolean {
    return line.length < 200
        && KEY_LINE_RE.test(line)
        && !line.trim().startsWith('-')
        && line.search(/\S|$/) <= 1;
}

/**
 * 按顶层键切分为区块 Map（键 → 块值，含首行内联值 + 余行）。
 * 生产消费方：generation 的 prefill 首键派生与 personaGen 组装；
 * smoke 锁解析契约。（「这份 schema 能不能用」不归它判——见
 * isSchemaSkeleton：块数 > 0 只证明「切给出过一行带冒号的文本」。）
 */
export function parseYamlToBlocks(text: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (!text || typeof text !== 'string') return map;
    try {
        // 剥可能残留的 yaml 围栏
        const cleanText = stripFence(text);
        let lines = cleanText.split('\n');
        // 收集所有顶层键行索引（判定条件比切块更宽：允许任意缩进的
        // 「键:」行——用于单顶层键误嵌套检测）
        const topKeyIndices: number[] = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.length < 200 && KEY_LINE_RE.test(line) && !line.trim().startsWith('-') && isUnindented(line)) {
                topKeyIndices.push(i);
            }
        }
        // 单顶层键 + 后续内容有统一缩进 → 整块去缩进（修复模型把唯一
        // 顶层键下全部子块再缩进一级的形态）
        if (topKeyIndices.length === 1 && lines.length > 2) {
            const remainingLines = lines.slice(topKeyIndices[0] + 1);
            let minIndent = Number.POSITIVE_INFINITY;
            let hasContent = false;
            for (const l of remainingLines) {
                if (l.trim().length > 0) {
                    const indent = l.search(/\S|$/);
                    if (indent < minIndent) minIndent = indent;
                    hasContent = true;
                }
            }
            if (hasContent && minIndent > 0 && minIndent !== Number.POSITIVE_INFINITY) {
                lines = remainingLines.map(l => (l.length >= minIndent ? l.substring(minIndent) : l));
            }
        }
        let currentKey: string | null = null;
        let currentBuffer: string[] = [];
        const flushBuffer = (): void => {
            if (currentKey && currentBuffer.length > 0) {
                const firstLine = currentBuffer[0];
                const match = firstLine.match(KEY_LINE_RE);
                let valuePart = '';
                if (match) {
                    const inlineContent = firstLine.substring(match[0].length).trim();
                    const blockContent = currentBuffer.slice(1).join('\n');
                    if (inlineContent && blockContent) valuePart = `${inlineContent}\n${blockContent}`;
                    else if (inlineContent) valuePart = inlineContent;
                    else valuePart = blockContent;
                } else {
                    valuePart = currentBuffer.join('\n');
                }
                map.set(currentKey, valuePart);
            }
        };
        lines.forEach(line => {
            if (isTopLevelKeyLine(line)) {
                flushBuffer();
                currentKey = (line.match(KEY_LINE_RE) as RegExpMatchArray)[1].trim();
                currentBuffer = [line];
            } else if (currentKey) {
                currentBuffer.push(line);
            }
        });
        flushBuffer();
    } catch {
        // 解析异常＝不可解析（空 Map），不抛出
    }
    return map;
}

/**
 * 策展产出是否是一份可用的 schema 骨架（「键名清单」——值为空的 YAML）。
 *
 * 为什么不能只看「切得出顶层键」：那等于问「这段文本里有没有一行以键名
 * 加冒号开头」，任何散文都天然满足。「连接目标服务失败：」「请求地址: …」
 * 这类上游错误正文因此会被判成合法 schema，一路传进第二段生成（实测
 * 事故：整段错误文本成了档案段的 <target_schema>，prefill 首键被派生成
 * 「连接目标服务失败:」）。
 *
 * 判据按策展任务的输出契约取（prompts/defaults 的策展指令：只输出键名、
 * 值为空、无任何解释）：
 *   1. 至少两个顶层键——单一「键:」行同样是散文的常见形状（「请求地址: …」
 *      「失败原因：」），一份真骨架至少分基本信息与一个别的块；
 *   2. 每个非空行都必须是严格键行（SCHEMA_KEY_LINE_RE）、列表项或缩进
 *      内容——**顶格的散文即出局**；
 *   3. 每个顶层键行都必须是严格键行——散言前导（「好的，以下是为你定制
 *      的骨架：」）带子句标点，在此出局。
 * 第 3 条是防「换皮」的关键：宽松键正则会把散文句认成键，而该键会被
 * profilePrefillFor 派生成第二段的起手词，等于把错误正文又送进去一次。
 *
 * 残余面（文本形状判据的固有边界，非未竟事项）：形如「失败原因：／请求
 * 地址：／重试建议：」的**全短句列**与合法骨架（「目标：／能力：／背景：」）
 * 在文本形状上完全同构——区分它们需要语义知识（哪些词是合法字段名），
 * 文本校验原理上给不出。真要收口只能靠结构化来源（宿主错误信封），
 * 属跨仓改动，不在本判据职责内。
 *
 * 判错方向的代价不对称：把可用骨架误判为不可用，退到内置默认模板
 * （DEFAULT_TEMPLATES.user，一份完整可用骨架），损失只是模型定制的那几
 * 个键；反过来放行一段散文，会把错误带进后续所有段。故从严。
 */
export function isSchemaSkeleton(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    // 剥围栏后逐行判（与 parseYamlToBlocks 同口径，避免围栏行被当成散文）
    const cleanText = stripFence(text);
    if (cleanText === '') return false;
    const lines = cleanText.split('\n');
    const topKeys: string[] = [];
    for (const line of lines) {
        if (line.trim() === '') continue;
        const strictKey = line.match(SCHEMA_KEY_LINE_RE);
        const isStrictKey = strictKey !== null && !line.trim().startsWith('-');
        // 会成为块界的行（与切块共用同一判定）必须是严格键行：否则就是
        // 「校验说放行、切块却当新块」的分歧（1 空格缩进的散言行即此形）。
        // 非块界行（真缩进内容、列表项）从宽——它们不会影响块结构。
        if (isTopLevelKeyLine(line)) {
            if (!isStrictKey) return false;
            topKeys.push((strictKey as RegExpMatchArray)[1].trim());
            continue;
        }
        const isListItem = line.trim().startsWith('-');
        const isNested = line.search(/\S|$/) > 0;
        if (!isStrictKey && !isNested && !isListItem) return false;
    }
    return topKeys.length >= 2;
}

// ---------------------------------------------------------------------------
// 档案段（已填满的档案）的叶级解析与形状校验——判据层的输入层
// ---------------------------------------------------------------------------

/**
 * 为什么与 parseYamlToBlocks 分家而不复用它的切块结果：**两者面对的输入
 * 形状不同，块界定义也必须不同**，共用一条定义必然让其中一个失效。
 *   - parseYamlToBlocks 服务「切块」：模型原始产出与策展段骨架都在里面，缩进
 *     ≤1 一律按块界处理（模型常用 1 空格缩进子键，按块界可把骨架摊平）。
 *   - 本模块服务「判据」：档案段产出是填好的档案，叶必须逐个取到。沿用 ≤1 的
 *     块界，1 空格缩进的叶会被读成顶层块、原来那个块变成零叶，而「零叶」与
 *     「确实没重复」在数据上不可区分——那是静默全绿。
 *
 * 本模块自持的块界定义：**缩进 0 是块，其余缩进都是块内的叶**；比当前叶更深的
 * 键行算该叶的续行（模板叶块的状态三键结构），与 definitionRowKeysFromSchema
 * 的「深层子键不进键集」同口径。
 *
 * 与上半 `isTopLevelKeyLine` 的分工（两处互为对读的一对）：那条是**策展段
 * 那一路**的唯一定义、两条调用方共用；本段是**档案段那一路**的唯一定义，
 * 只有 scan 家族用、不调用那条。两条的分歧只在畸形输入上显形——策展产出过了
 * 骨架判据、叶就是两格缩进，此时两者一致；档案段宁可宽松读也不要零叶。
 */

/** 档案叶值形态：scalar＝标量（首行内联或缩进续行）；list＝值由 '- ' 项承载。 */
export type ProfileLeafForm = 'scalar' | 'list';

export interface ProfileLeafRow {
    block: string;
    leaf: string;
    /** 未归一的原始值（首行内联 ＋ 续行，以 \n 连接）。 */
    value: string;
    form: ProfileLeafForm;
    /**
     * 该叶在 `splitProfileLines` 结果里的行号跨度（0 基，含首行含末行）。
     *
     * 消费方：按「块·叶」精确改写那一轮复核（整叶替换＝替换 [lineStart,
     * lineEnd] 这段行，而不是全档正则替换——正则替不掉缩进与列位，替了就把
     * 档案排版改掉）。
     */
    lineStart: number;
    lineEnd: number;
    /**
     * 值在 `lines[lineStart]` 里的起始下标（0 基）。
     *
     * 为什么给偏移而不是给「键前缀文本」：同一叶在档案里有两种行形态（缩进
     * 叶行 `  姓名: 阿槐`，块首行内联首叶 `基本信息:姓名: 阿槐`），两者的
     * 前缀逐字不同，而替换要保留的恰恰是前缀本身——偏移对两种形态同构。
     */
    valueStart: number;
}

export interface ProfileScan {
    /** 顶层块名，按出现顺序。 */
    blocks: ReadonlyArray<string>;
    leaves: ReadonlyArray<ProfileLeafRow>;
    /** 顶层块行的键名（裸块名），按出现顺序。 */
    blockKeys: ReadonlyArray<string>;
    /** 叶行的限定名「块·叶」，按出现顺序（模板叶块里模型自造的叶名照样进来）。 */
    leafKeys: ReadonlyArray<string>;
    /**
     * 无主行：没有开着的叶可以并入的列表项与缩进散文（原样行文本）。
     *
     * 它们以前被静默丢弃，而静默丢弃正是本层立身要消灭的东西：解析层把行
     * 带出来，判据层决定它算不算「未识别叶」（它是内容，没被任何叶认领）。
     */
    orphanLines: ReadonlyArray<string>;
}

/**
 * 不可判定的机器分类码。
 *
 * **消费方一律按 code 分支，不许拿人读文案做分类**：文案一改，按
 * `includes('单块档案·不可判定')` 判形态的消费方就静默失效，而失效方向是
 * 「把不可判定当没重复」——那正是本层最危险的谎。
 */
export type ProfileUndecidableCode = 'EMPTY' | 'SINGLE_BLOCK' | 'NO_LEAVES' | 'MOSTLY_OUT_OF_CATALOG';

/** 分类码 → 人读文案（进异常 message 与简报；文案改动不牵动分类）。 */
const UNDECIDABLE_TEXT: Readonly<Record<ProfileUndecidableCode, string>> = {
    EMPTY: '空档案·不可判定',
    SINGLE_BLOCK: '单块档案·不可判定',
    NO_LEAVES: '零叶档案·不可判定',
    MOSTLY_OUT_OF_CATALOG: '目录外叶过半·不可判定',
};

/** 不可判定异常：code 给机器分形态，message 给用户看形态。 */
export class ProfileUndecidableError extends Error {
    readonly code: ProfileUndecidableCode;
    readonly topLevelBlocks: number;
    readonly leafCount: number;

    constructor(code: ProfileUndecidableCode, topLevelBlocks: number, leafCount: number) {
        super(`档案不可判定：${UNDECIDABLE_TEXT[code]}（顶层块 ${topLevelBlocks}／叶 ${leafCount}）`);
        this.name = 'ProfileUndecidableError';
        this.code = code;
        this.topLevelBlocks = topLevelBlocks;
        this.leafCount = leafCount;
    }
}

export interface ProfileShape {
    ok: boolean;
    /** 不可判定的分类码（ok 时为 null）；形状闸只出前三个，MOSTLY_OUT_OF_CATALOG 由判据层出。 */
    code: ProfileUndecidableCode | null;
    topLevelBlocks: number;
    leafCount: number;
}

/**
 * 顶格「块行」的切分：**刻意宽**——在第一个冒号处切开，冒号后允许零空白。
 *
 * 宽的理由：档案段 prefill 接写出来的形态是 `基本信息:姓名: 测试`（块名与内联首叶
 * 之间没有空白）。窄式在第一个冒号后要求空白，整行不匹配，块连同它的内联首叶一起
 * 消失——这正是加固②要治的丢首叶。同一批宽式也把 `连接目标服务失败：当前网络…`
 * 这类中文散文行认成块（它本来就不带叶，只占一个未识别块），无害。
 *
 * 它**只负责切块行**。切出来的余下部分（`姓名: 测试`）与块内叶行走下面那条严式
 * ——两式同宽才是漏洞：宽式认键会把 `https://`、`12:30`、`3:1` 里紧贴非空白的冒号
 * 当成分隔符，凭空长出一个名「https」的叶。
 */
const PROFILE_BLOCK_SPLIT_RE = /^([^:：\-][^:：]*?)\s*[:：]\s*(.*)$/;

/**
 * 键行判定（**键名宽于 KEY_LINE_RE，冒号严于块行切分式**）：键名允许空白与连字符，
 * 冒号后必须跟空白或行尾。
 *
 * 键名放宽的理由：机制挂载块按该世界的原生词汇命名——`HP 成长`、`赛博-404 协议`
 * 这类名字在 `KEY_LINE_RE` 的键名字符类里（排除空白与连字符）整行不匹配，被当成
 * 块内容并静默丢弃，于是该块的叶在判据眼里凭空消失（连「这里本该有内容」都看不到）。
 *
 * 冒号不放宽的理由：宿主错误正文的 `  https://api.example.com/v1/chat/completions`
 * 会在叶行位置长出一个名「https」的叶，零叶档案于是「通过」了叶级解析。
 *
 * 块首行里挂着的内联首叶走同一条式，不再各写一份。
 */
const PROFILE_KEY_RE = /^([^:：\-][^:：]*?)\s*[:：](?:\s+(.*)|\s*$)/;

/** 制表符缩进折算成两格：\t 开头的叶按原口径算缩进 0，会被当成顶层块。 */
function normalizeIndent(line: string): string {
    return line.replace(/^\t+/, tabs => '  '.repeat(tabs.length));
}

/**
 * 值在该行里的起始下标（复核轮的整叶替换靠它保留键前缀逐字）。
 *
 * 两个键正则都是「从键一路匹配到行尾」，`match[0].length` 量的是**整行剩余
 * 部分**的长度，不是「键 ＋ 冒号」的长度：直接拿它当值起点，改写会落在原值
 * 之后（新值被追加到旧值尾部），而两道改后校验照样绿——叶名清单没变，也没
 * 制造新的完全同值组，只有档案内容错了。所以值起点＝行首偏移＋（匹配长度
 * －值自身长度）。`value` 必须传**未 trim 的捕获组**：它就是 `match[0]` 的
 * 尾巴，减它的长度才等于它在行内的起点。
 */
function valueStartIn(indent: number, matched: RegExpMatchArray, value: string): number {
    return indent + matched[0].length - value.length;
}

/**
 * 档案正文的行切分（**档案段那一路的唯一定义**，本文件下半段的扫描器与
 * 复核轮的行级改写共用它）。
 *
 * 三件事在这里定死，各消费方不再各做一遍：剥围栏、制表符折算、按物理行切。
 * 改写那一轮要按 `ProfileLeafRow.lineStart/lineEnd/valueStart` 定位回原行，
 * 行数组与扫描器看到的那一份必须逐行相同——不同源时「行号」是个没有定义
 * 的数字，替换会落在别的行上，而档案看上去仍然「是一份档案」。
 */
export function splitProfileLines(text: unknown): string[] {
    if (typeof text !== 'string') return [];
    const clean = stripFence(text);
    return clean === '' ? [] : clean.split('\n').map(normalizeIndent);
}

/**
 * 档案的叶级扫描：逐行取块与叶，并按「块行／叶行／无主行」三路带出键名清单
 * （哪一路算未识别由消费方对目录求差集决定——本层不认目录，它是纯语法层，
 * 目录改名不该让解析层跟着动）。
 *
 * 四个形态的读法写在这里，判据层不得另立一套：
 *   - 块首行的内联值（实测形态「基本信息:姓名: 测试」）：同一个冒号里先块名
 *     后叶名。该叶与它后面各缩进叶同属块的子键层，故开完即收——只认缩进的话
 *     首叶被静默丢掉，而档案段 prefill 接写的形态恰好总是这样。
 *   - 比**块内首个叶行**更深的键行：并进当前叶的值（模板叶块的状态三键），
 *     不开新叶。基准取首叶而不取上一个叶：同一块里叶缩进一深一浅时（模型常
 *     见先 4 空格后 2 空格），拿上一个叶当基准会把后一个 4 空格叶吞进 2 空格子
 *     叶的值里——既不进叶也不进未识别，静默全绿。切块时重置基准。
 *   - '- ' 开头：并进当前叶并把值形态改判为 list（值不由单个字符串承载，
 *     「同值」无从谈起；判据层据此排除，见 ProfileLeafRow.form）。没有开着的
 *     叶可并时它是裸列表项，进无主行。
 *   - 顶格非键行（散文、围栏残渣）不建任何键；缩进的非键行没有叶可并时同样
 *     进无主行。
 */
function scan(text: unknown): ProfileScan | null {
    const lines = splitProfileLines(text);
    if (lines.length === 0) return null;
    const blocks: string[] = [];
    const blockKeys: string[] = [];
    const leafKeys: string[] = [];
    const orphanLines: string[] = [];
    const leaves: ProfileLeafRow[] = [];
    let currentBlock = '';
    let openLeaf: ProfileLeafRow | null = null;
    /** 该块的叶层基准＝块内首个叶行的缩进；换块即重置。 */
    let leafLayerIndent = -1;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const body = line.trim();
        if (body === '') continue;
        const indent = line.search(/\S|$/);

        if (body.startsWith('-')) {
            if (openLeaf) {
                openLeaf.form = 'list';
                openLeaf.value = openLeaf.value === '' ? body : `${openLeaf.value}\n${body}`;
                openLeaf.lineEnd = index;
            } else {
                orphanLines.push(body);
            }
            continue;
        }

        const key = indent === 0 ? body.match(PROFILE_BLOCK_SPLIT_RE) : body.match(PROFILE_KEY_RE);
        if (!key) {
            // 非键行：缩进的算当前叶的续行（无叶可并时进无主行），顶格的不建任何键
            if (indent > 0) {
                if (openLeaf) {
                    openLeaf.value = openLeaf.value === '' ? body : `${openLeaf.value}\n${body}`;
                    openLeaf.lineEnd = index;
                } else {
                    orphanLines.push(body);
                }
            }
            continue;
        }

        const name = key[1].trim();
        const rawRest = key[2] ?? '';
        const rest = rawRest.trim();
        if (indent === 0) {
            openLeaf = null;
            leafLayerIndent = -1;
            currentBlock = name;
            blocks.push(name);
            blockKeys.push(name);
            const inline = rawRest.match(PROFILE_KEY_RE);
            if (inline) {
                const leaf = inline[1].trim();
                leafKeys.push(`${name}·${leaf}`);
                leaves.push({
                    block: name,
                    leaf,
                    value: (inline[2] ?? '').trim(),
                    form: 'scalar',
                    lineStart: index,
                    lineEnd: index,
                    // 块名与内联首叶之间的偏移：(行内块后缀起点) + (内联值起点)
                    valueStart: valueStartIn(indent + (body.length - rawRest.length), inline, inline[2] ?? ''),
                });
            }
            continue;
        }
        // 缩进键行：块还没开出来之前出现的键没有归属，进无主行
        if (currentBlock === '') {
            orphanLines.push(body);
            continue;
        }
        if (openLeaf && indent > leafLayerIndent) {
            openLeaf.value = openLeaf.value === '' ? body : `${openLeaf.value}\n${body}`;
            openLeaf.lineEnd = index;
            continue;
        }
        if (leafLayerIndent < 0) leafLayerIndent = indent;
        openLeaf = {
            block: currentBlock,
            leaf: name,
            value: rest,
            form: 'scalar',
            lineStart: index,
            lineEnd: index,
            // 键前缀（缩进与叶名与冒号与其后的空白）逐字保留，值从其后开始
            valueStart: valueStartIn(indent, key, rawRest),
        };
        leafKeys.push(`${currentBlock}·${name}`);
        leaves.push(openLeaf);
    }
    return { blocks, leaves, blockKeys, leafKeys, orphanLines };
}

/** 形状判定的共用实现（ok 与 code 出自同一处，不许各写一份判定）。 */
export function shapeOfScan(result: ProfileScan | null): ProfileShape {
    if (!result) return { ok: false, code: 'EMPTY', topLevelBlocks: 0, leafCount: 0 };
    const counts = { topLevelBlocks: result.blocks.length, leafCount: result.leaves.length };
    if (counts.topLevelBlocks < 2) return { ok: false, code: 'SINGLE_BLOCK', ...counts };
    if (counts.leafCount === 0) return { ok: false, code: 'NO_LEAVES', ...counts };
    return { ok: true, code: null, ...counts };
}

/**
 * 档案段入口侧的形状校验：这份文本能不能进叶级判定。
 *
 * **档案段此前从不跑任何形状校验**（isSchemaSkeleton 只服务策展段），而判据层
 * 的两条规则都建立在「这是一份填好的档案」之上——前提不成立时报出来的零命中
 * 与「确实没有重复」不可区分。入口侧先过这一道，判据层才有资格开口。
 *
 * 三条不成立的形态各带一个分类码：
 *   - EMPTY（空串/非字符串/剥完围栏没内容）；
 *   - SINGLE_BLOCK（顶层块 <2）——单块形态会踩「单顶层键整块去缩进」的修复分支，
 *     该分支丢掉顶层键并把它的子键提升成顶层块，在档案上就是「块名被吃掉、叶挂
 *     到了块外」；
 *   - NO_LEAVES（零叶）——宿主错误正文（「请求地址: https://…」这类整行键）与
 *     块界塌陷后的档案都落在这里。
 *
 * 「是不是档案」的第四道（目录外叶过半 MOSTLY_OUT_OF_CATALOG）不在这里：解析层
 * 不认目录，那道判定连同它要的目录键集都在判据层（redundancy.ts）。
 */
export function checkProfileShape(text: unknown): ProfileShape {
    return shapeOfScan(scan(text));
}

/**
 * 叶级解析：**只如实报告扫到了什么，不判断这份文本可不可用**。
 *
 * 抛错的判据闸在 `analyzeRedundancy` 那道边界上，不在这里——`checkProfileShape`
 * 已经是不抛错的形状视图，扫描器再抛一次就是同一道闸写两遍；而扫描器的正当用法
 * 恰恰包含「明知它形状不对、就是要看它扫出了什么」（回归用例里全是单块、半截、
 * 畸形文本）。判据闸抛 `ProfileUndecidableError` 而不是返回空报告：空报告在下游
 * 与「档案里没有重复」同形，调用方拿到的是绿灯而实际什么都没判。
 */
export function scanProfileLeaves(text: unknown): ProfileScan {
    return scan(text) ?? { blocks: [], leaves: [], blockKeys: [], leafKeys: [], orphanLines: [] };
}
