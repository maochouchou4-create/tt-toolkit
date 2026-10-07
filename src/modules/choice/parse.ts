/**
 * 选项输出解析（服务商结构化输出为主＋客户端元素级恢复兜底）。
 *
 * 主路径：JSON 对象契约 {"options":[...]}（与 json_object 档「输出必须
 * 是对象」的规范对齐；裸数组容错保留，兼容旧输出）。LLM 常见畸形先
 * 修复——尾随逗号、markdown 代码围栏、思维链标签前缀。
 * 元素级恢复：容器完整 parse 失败而 "options" 锚点在场时，用字符串感知
 * 的逐元素扫描（RFC 8259 §7 转义状态机）切出每个完整 {...} 元素单独
 * parse——中转站截断常表现为「每条选项本身完整、只缺容器收尾 ]}」，
 * 容器级 parse 会把整批可用品连坐作废；恢复成功记 partial＋残缺丢弃数。
 * 切出的片段 parse 成功不构成切分正确的证据（值内未转义引号会错位出
 * 恰好合法的子串），每元素之后必须做分隔符严格校验：其后首个非空白
 * 字符只能是 , / ] / EOF（RFC 8259 §5/§6 值分隔语法）——违者整批判
 * 损坏，交骸骨守门拒收，绝不把坏 JSON 静默恢复成垃圾选项。
 * 兜底路径：行首 [标题]/【标题】括号启发式——response_format 不被
 * 支持/被忽略/解析失败时的确定性回退；零标题命中时不再把整段散文
 * 合成为单条无标题选项（fail fast 可见优于静默降级）。
 * 纯函数：畸形输入的回退行为可确定性触发与断言（冒烟判据）。
 */

export interface ParsedOption {
    title: string;
    content: string;
}

/** 解析路径溯源（dump/排障：走了 JSON 主路径、元素级恢复还是括号回退）。 */
export interface ParseReport {
    path: 'json' | 'partial' | 'bracket_fallback' | 'json_reject' | 'empty';
    options: ParsedOption[];
    /**
     * partial 专用：残缺丢弃的尾元素数（切片前统计，与 count 截断无关）。
     * 其余路径缺席；恢复条数恒等于 options.length，不另设字段（防双真相源）。
     */
    dropped?: number;
}

const REASONING_TAG_RE = /<(?:think(?:ing)?|reasoning|thought|antThinking)>[\s\S]*?<\/(?:think(?:ing)?|reasoning|thought|antThinking)>/gi;
/** 闭合标签作分隔符（split 用；g 标志对 split 无意义，语义＝每个闭合点都是切分边界）。 */
const REASONING_CLOSE_SPLIT_RE = /<\/(?:think(?:ing)?|reasoning|thought|antThinking)>/i;

/**
 * 思维链剥离：存在闭合标签时丢弃最后一个闭合标签之前的全部内容（模型
 * 可能在思维链里以文本提到 <options>/JSON 契约——全文搜块标签会误匹配
 * 这些文本引用）；无闭合标签时剥配对标签块。
 *
 * 表达距离声明：AFPL 合规——fork 按「matchAll 收集全部闭合点→取末个
 * 索引→slice」实现，本实现改用「以闭合标签为分隔符 split，取末段」的
 * 等价表达（末段＝最后一个闭合标签之后的全部文本）。
 */
function stripReasoning(text: string): string {
    const segments = text.split(REASONING_CLOSE_SPLIT_RE);
    if (segments.length > 1) return segments[segments.length - 1].trim();
    return text.replace(REASONING_TAG_RE, '').trim();
}

/**
 * 剥 markdown 代码块围栏（模型爱把 JSON 装进 ```json 围栏）。
 *
 * 表达距离声明：AFPL 合规——fork 按两条锚定 replace 链式剥除，本实现
 * 改用「开头截断＋结尾 endswith 切尾」的字符串操作表达；语义不变＝
 * 开栏（```＋语言标记）与闭栏各自独立剥除，围栏内外的正文不动。
 */
function stripCodeFence(text: string): string {
    let body = text.trim();
    const openFence = /^```[a-zA-Z]*\s*/.exec(body);
    if (openFence) body = body.slice(openFence[0].length);
    if (body.endsWith('```')) body = body.slice(0, -3);
    return body.trim();
}

/** 提取 <options> 块内容（无闭合标签时取开标签之后全部——截断容错）。 */
function extractOptionsBlock(text: string): string {
    const m = text.match(/<options>([\s\S]*?)<\/options>/i);
    if (m) return m[1].trim();
    const open = text.search(/<options>/i);
    if (open !== -1) return text.slice(open + '<options>'.length).trim();
    return text;
}

/**
 * LLM 常见 JSON 畸形修复：尾随逗号（,] 与 ,}）。
 *
 * 表达距离声明：AFPL 合规——fork 用「逗号＋捕获定界符→回填定界符」的
 * 替换模板，本实现改用前视断言：逗号后仅隔空白即到容器闭合处时删逗号
 * 本身，定界符零改写。
 */
function fixTrailingCommas(text: string): string {
    return text.replace(/,(?=\s*[}\]])/g, '');
}

/** 单个元素 → 选项（{title,content}／{title,text}／纯字符串容错；空项为 null）。 */
function toOption(item: unknown): ParsedOption | null {
    if (typeof item === 'string') return { title: '', content: item.trim() };
    if (typeof item !== 'object' || item === null) return null;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const content = typeof o.content === 'string' ? o.content.trim() : typeof o.text === 'string' ? o.text.trim() : '';
    return title || content ? { title, content } : null;
}

/**
 * JSON 数组解析（主路径）：兼容 {title,content}／纯字符串元素。
 * 非数组/解析失败/解析后全空返回 null。
 */
function parseJsonArray(text: string): ParsedOption[] | null {
    try {
        const parsed = JSON.parse(fixTrailingCommas(text)) as unknown;
        if (!Array.isArray(parsed)) return null;
        const options = parsed
            .map(toOption)
            .filter((o): o is ParsedOption => o !== null);
        return options.length > 0 ? options : null;
    } catch {
        return null;
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWsChar(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipWs(text: string, from: number): number {
    let i = from;
    while (i < text.length && isWsChar(text[i])) i++;
    return i;
}

/**
 * 字符串感知的扫描游标（RFC 8259 §7）：inString／escape 双标志决定结构
 * 字符是否承重——正文里出现 {}[]":, 或转义序列只在字符串内，不参与
 * 容器结构判定（防「正文含花括号被误当边界」）。
 */
interface ScanCursor {
    inString: boolean;
    escape: boolean;
}

/** 单步推进游标；返回该字符是否处于字符串外（承重字符判定的依据）。 */
function stepCursor(cursor: ScanCursor, ch: string): boolean {
    if (cursor.inString) {
        if (cursor.escape) cursor.escape = false;
        else if (ch === '\\') cursor.escape = true;
        else if (ch === '"') cursor.inString = false;
        return false;
    }
    if (ch === '"') cursor.inString = true;
    return true;
}

/**
 * 顶层锚点：字符串外首个「后紧跟 `:` `[`」的 `"options"` 键，返回 `[` 之后
 * 下标；无锚点 -1。
 *
 * 候选不成立时继续往后扫而非短路返回：`"options"` 可能先作为普通词出现
 * （正文讨论、或被引号包住的字符串值），此时真正的契约锚点还在后面——
 * 短路会让本该恢复的选项连坐作废（与「容器缺收口整批作废」同一类损失）。
 */
function findTopLevelOptionsAnchor(text: string): number {
    const KEY = '"options"';
    const cursor: ScanCursor = { inString: false, escape: false };
    for (let i = 0; i < text.length; i++) {
        if (!stepCursor(cursor, text[i])) continue;
        if (!text.startsWith(KEY, i)) continue;
        let j = skipWs(text, i + KEY.length);
        if (text[j] !== ':') continue;
        j = skipWs(text, j + 1);
        if (text[j] === '[') return j + 1;
    }
    return -1;
}

/** 从 `{` 起扫出配对 `}` 下标；未闭合 -1（depth 计数＋字符串感知）。 */
function scanObjectElementEnd(text: string, from: number): number {
    const cursor: ScanCursor = { inString: false, escape: false };
    let depth = 0;
    for (let i = from; i < text.length; i++) {
        const ch = text[i];
        if (!stepCursor(cursor, ch)) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * 容器闭合后的尾部残留是否还带着一份契约陈述（第二份 options 对象、
 * 或裸契约键字面量）。命中＝流已损坏（后缀被吞或拼接了第二份输出），
 * 整批拒收交上层报错带出原文。
 * `"options"` 臂要求其后是 `[`（键后跟数组字面量）——尾部散文里
 * 逐字引用「"options": 数组格式」一类的格式说明不算契约陈述。
 */
function residueStatesContract(residue: string): boolean {
    return /"options"\s*:\s*\[/.test(residue)
        || residue.includes('"title"') || residue.includes('"content"');
}

/** 元素级扫描产物：恢复出的选项＋残缺丢弃数＋容器是否完整收口。 */
interface ElementScan {
    options: ParsedOption[];
    dropped: number;
    closed: boolean;
}

/**
 * 容器收口单点：扫到数组收口的 `]` 后判定整批走向。
 * - `]` 后首个非空白字符是 `}` → 容器闭合；其后的尾部残留含契约陈述
 *   （第二份契约）＝流损坏整批拒收，否则采信（散文/无害残渣不连坐）；
 * - `]` 后是别的结构字符 → 收口点后跟垃圾＝破损流，整批拒收；
 * - EOF → 容器未收口（截断形态），元素级恢复语义保留。
 */
function closeContainer(text: string, bracketIndex: number, options: ParsedOption[]): ElementScan | null {
    const after = skipWs(text, bracketIndex + 1);
    if (after >= text.length) return { options, dropped: 0, closed: false };
    if (text[after] !== '}') return null;
    const residue = text.slice(after + 1).trim();
    if (residue !== '' && residueStatesContract(residue)) return null;
    return { options, dropped: 0, closed: true };
}

/**
 * 对象契约的元素级扫描：从 "options" 锚点逐元素切完整 {...} 单独 parse。
 *
 * 四条终止语义（必须分开，不得合并）：
 * - 元素后到 EOF 只有空白＝容器未收口但元素完整 → 合法恢复（不闭合）；
 * - 扫到 `]` 交容器收口单点（closeContainer：闭合校验＋尾部契约锚点校验）；
 * - 元素不完整/parse 失败＝残缺起点 → 丢弃该元素并停扫（后续必然更残）；
 * - 元素后出现 , ] EOF 之外的首个非空白字符＝流损坏（inString 错位或
 *   提前闭合——「能 parse 成功」是巧合不是正确性证据）→ 整批拒绝（null）。
 */
function scanContractElements(text: string): ElementScan | null {
    let i = findTopLevelOptionsAnchor(text);
    if (i < 0) return null;
    const options: ParsedOption[] = [];
    for (;;) {
        i = skipWs(text, i);
        if (i >= text.length) return { options, dropped: 0, closed: false };
        const ch = text[i];
        if (ch === ']') return closeContainer(text, i, options);
        if (ch !== '{') return null;
        const close = scanObjectElementEnd(text, i);
        if (close < 0) return { options, dropped: 1, closed: false };
        let element: ParsedOption | null = null;
        try {
            element = toOption(JSON.parse(fixTrailingCommas(text.slice(i, close + 1))));
        } catch {
            element = null;
        }
        if (element === null) return { options, dropped: 1, closed: false };
        options.push(element);
        i = skipWs(text, close + 1);
        if (i >= text.length) return { options, dropped: 0, closed: false };
        const sep = text[i];
        if (sep === ',') {
            i += 1;
            continue;
        }
        if (sep === ']') return closeContainer(text, i, options);
        return null;
    }
}

/**
 * 「像 JSON」结构判定（骸骨守门判据的单点收敛）：数组开头且 `[` 后首个非
 * 空白字符是 `{` 或 `"`（JSON 数组形态——`[标题]正文` 的设计形态首字符是
 * 标题文字，不误伤）；或全文含契约键字面量（兜住散文前缀＋截断 JSON 的
 * 混合形态）。
 *
 * 不判「以 `{` 开头」：调用点在对象契约分支之后，该形态已被前序分支全部
 * 接管（`{` 开头的文本到不了这里），写进来即不可达判据。
 */
function looksLikeJsonShaped(text: string): boolean {
    return /^\[\s*[{"]/.test(text)
        || text.includes('"title"') || text.includes('"content"') || text.includes('"options"');
}

/**
 * 括号回退（兜底路径）：[标题]/【标题】开启新选项，其后到下一括号前的
 * 文本为正文。正文里再出现括号不切分——区分依据是位置：只有与上个括号
 * 之间隔着「换行或正文」的括号才是新选项边界；间隙仅空白/emoji 的连续
 * 括号是标签堆叠（AI 在正文开头加场景头括号的实测形态——逐括号切会把
 * 一条选项切成「[标题]」和「[场景头]正文」两条）。
 */
interface BracketEntry extends ParsedOption {
    /** 标题括号闭合位置（堆叠合并时扩正文区间用） */
    titleEnd: number;
}

function parseBracketFallback(text: string): ParsedOption[] {
    const TITLE_RE = /[[【]([^\]】]+?)[\]】]/g;
    /**
     * 间隙判定（标签堆叠 vs 新选项边界）。
     *
     * 表达距离声明：AFPL 合规——fork 把 emoji 组合后缀写成
     * \uFE0F/\u200D/\u20E3 转义堆叠，本实现按 Unicode 属性类＋具名码位
     * 自组，逐字符注明标准依据：
     *   - \p{Extended_Pictographic}：emoji 基字符（UTS #51 §2）；
     *   - \p{Variation_Selector}：变体选择符区间 U+FE00..U+FE0F（UAX #44
     *     属性）；其中 VS16＝U+FE0F 是 emoji 呈现选择符（如 🎞＋FE0F），
     *     常见于模型输出的装饰行；
     *   - \u{200D}：ZWJ 零宽连接符（U+200D，UAX #44 Join_Control 属性的
     *     两成员之一）——组合 emoji 序列（家庭/职业类）靠它连接；
     *   - \u{20E3}：键帽封套 COMBINING ENCLOSING KEYCAP（U+20E3，
     *     UAX #44 Grapheme_Extend 属性）——1️⃣ 类键帽序列的封套字符；
     *   - \p{Emoji_Modifier}：肤色修饰符区间 U+1F3FB..U+1F3FF（UTS #51
     *     §2.4 Emoji_Modifier 属性）——👍🏽 类肤色变体的后缀。
     * 语义不变：间隙全由「行内空白（不含换行）」或「emoji 基字符后跟
     * 任意数量的上述组合后缀」组成＝标签堆叠；否则＝新选项边界。
     */
    const GAP_RE = /^(?:[^\S\r\n]|\p{Extended_Pictographic}(?:\p{Variation_Selector}|\u{200D}|\u{20E3}|\p{Emoji_Modifier})*)*$/u;
    const matches = [...text.matchAll(TITLE_RE)];
    // 零标题命中＝模型没按选项格式输出：不再把整段散文合成为单条无标题
    // 选项（silent-failure——用户看不出坏了），交上层按 empty 报错带出原文
    if (matches.length === 0) return [];

    const entries: BracketEntry[] = [];
    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const start = m.index ?? 0;
        const titleEnd = start + m[0].length;
        const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
        // 间隙＝上一括号闭合处到本括号起点：空白/emoji（含空串）＝同一行
        // 标签堆叠并入上一条；含换行或正文＝新选项边界
        const prev = entries[entries.length - 1];
        const gap = prev ? text.slice(prev.titleEnd, start) : '';
        if (prev && GAP_RE.test(gap)) {
            // 堆叠：上一条正文区间重扩到 end（标题保持首括号）
            prev.content = text.slice(prev.titleEnd, end).replace(/\s+/g, ' ').trim();
            prev.titleEnd = titleEnd;
            continue;
        }
        entries.push({
            title: m[1].trim(),
            content: text.slice(titleEnd, end).replace(/\s+/g, ' ').trim(),
            titleEnd,
        });
    }
    return entries
        .filter(e => e.title || e.content)
        .map(({ title, content }) => ({ title, content }));
}

/**
 * 解析入口：剥思维链 → 提 <options> 块 → 剥代码围栏 → JSON 主路径 →
 * 元素级恢复（partial）→ 骸骨守门 → 括号回退。count 截断（模型超发时
 * 只取前 N 条）。
 */
export function parseOptions(text: string, count: number): ParseReport {
    let c = stripReasoning(String(text ?? ''));
    c = extractOptionsBlock(c);
    c = stripCodeFence(c);
    if (!c) return { path: 'empty', options: [] };

    // 对象契约形态（主契约：{"options":[...]}——与 json_object 档「输出
    // 必须是对象」的规范对齐）：三级判定按序——完整 parse 采信；parse
    // 失败交元素级扫描；零可恢复元素才落骸骨守门
    if (c.startsWith('{')) {
        let parseFailed = false;
        try {
            const obj = JSON.parse(fixTrailingCommas(c)) as unknown;
            if (isPlainObject(obj) && Array.isArray(obj.options)) {
                const json = parseJsonArray(JSON.stringify(obj.options));
                // 空数组直接采信为 empty——落进元素扫描会把合法空态误报成 partial
                return json
                    ? { path: 'json', options: json.slice(0, count) }
                    : { path: 'empty', options: [] };
            }
        } catch {
            parseFailed = true;
        }
        if (!parseFailed) {
            // 完整 JSON 但无 options 数组（异构容器）——非契约形态，fail fast
            return { path: 'json_reject', options: [] };
        }
        const scan = scanContractElements(c);
        if (scan !== null && scan.options.length > 0) {
            // 容器完整收口且零丢弃＝流本身完好（截断只发生在容器收尾之后
            // 的无害尾部）→ 采信为主路径；元素级恢复产出才落 partial
            if (scan.closed && scan.dropped === 0) {
                return { path: 'json', options: scan.options.slice(0, count) };
            }
            return { path: 'partial', options: scan.options.slice(0, count), dropped: scan.dropped };
        }
        return { path: 'json_reject', options: [] };
    }
    // 裸数组容错（回退吸收保留）：兼容旧契约输出与不守对象契约的模型
    if (c.startsWith('[')) {
        const json = parseJsonArray(c);
        if (json) return { path: 'json', options: json.slice(0, count) };
    }
    // JSON 骸骨守门：主路径与元素级恢复都无产出而文本呈 JSON 形态时，
    // 不进括号回退——回退会把数组方括号当标题括号，把整坨 JSON 合成一
    // 条废选项（title=JSON 骸骨、content=尾随 }）。判据单一谓词化
    //（looksLikeJsonShaped），fail fast 交上层报错带出原文。
    if (looksLikeJsonShaped(c)) {
        return { path: 'json_reject', options: [] };
    }
    const fallback = parseBracketFallback(c);
    if (fallback.length === 0) return { path: 'empty', options: [] };
    return { path: 'bracket_fallback', options: fallback.slice(0, count) };
}

/**
 * 调试固定畸形样本（debugForceRaw 开关强制喂畸形输出，断言回退解析
 * 结果）：思维链前缀＋模型无视 JSON 契约的括号格式输出（[]/【】混用）
 * ——确定性走括号回退路径，解析出 4 条带标题选项。
 */
export const DEBUG_MALFORMED_RAW = [
    '<think>用户要 4 条行动选项。JSON 格式太容易出错了，直接按老格式写标题括号吧。</think>',
    '[推开酒馆的门]你推开那扇厚重的木门，热浪与喧闹扑面而来。',
    '[向老板打听]你挤到吧台前，压低声音问老板：「最近有没有见过一个穿斗篷的人？」',
    '【查看告示牌】你瞥见墙角的告示牌上贴着一张新的悬赏令。',
    '[转身离开]你环顾一圈后转身走出酒馆，决定去别处寻找线索。',
].join('\n');
