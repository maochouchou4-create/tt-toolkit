/**
 * 选项输出解析（方案 §1 P-JSON：服务商结构化输出为主＋客户端解析兜底）。
 *
 * 主路径：JSON 数组（输出契约要求；LLM 常见畸形先修复——尾随逗号、
 * markdown 代码围栏、单对象包裹、思维链标签前缀）。
 * 兜底路径：行首 [标题]/【标题】括号启发式——response_format 不被
 * 支持/被忽略/解析失败时的确定性回退。
 * 纯函数：畸形输入的回退行为可确定性触发与断言（批B 判据）。
 */

export interface ParsedOption {
    title: string;
    content: string;
}

/** 解析路径溯源（dump/排障：走了 JSON 主路径还是括号回退）。 */
export interface ParseReport {
    path: 'json' | 'bracket_fallback' | 'empty';
    options: ParsedOption[];
}

const REASONING_TAG_RE = /<(?:think(?:ing)?|reasoning|thought|antThinking)>[\s\S]*?<\/(?:think(?:ing)?|reasoning|thought|antThinking)>/gi;
const REASONING_CLOSE_RE = /<\/(?:think(?:ing)?|reasoning|thought|antThinking)>/gi;

/**
 * 思维链剥离：存在闭合标签时丢弃最后一个闭合标签之前的全部内容（模型
 * 可能在思维链里以文本提到 <options>/JSON 契约——全文搜块标签会误匹配
 * 这些文本引用）；无闭合标签时剥配对标签块。
 */
function stripReasoning(text: string): string {
    const closes = [...text.matchAll(REASONING_CLOSE_RE)];
    if (closes.length > 0) {
        const last = closes[closes.length - 1];
        return text.slice((last.index ?? 0) + last[0].length).trim();
    }
    return text.replace(REASONING_TAG_RE, '').trim();
}

/** 剥 markdown 代码块围栏（模型爱把 JSON 装进 ```json 围栏）。 */
function stripCodeFence(text: string): string {
    return text
        .replace(/^```[a-zA-Z]*\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
}

/** 提取 <options> 块内容（无闭合标签时取开标签之后全部——截断容错）。 */
function extractOptionsBlock(text: string): string {
    const m = text.match(/<options>([\s\S]*?)<\/options>/i);
    if (m) return m[1].trim();
    const open = text.search(/<options>/i);
    if (open !== -1) return text.slice(open + '<options>'.length).trim();
    return text;
}

/** LLM 常见 JSON 畸形修复：尾随逗号（,] 与 ,}）。 */
function fixTrailingCommas(text: string): string {
    return text.replace(/,(\s*[\]}])/g, '$1');
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
            .map(item => {
                if (typeof item === 'string') return { title: '', content: item.trim() };
                const o = (item ?? {}) as Record<string, unknown>;
                const title = typeof o.title === 'string' ? o.title.trim() : '';
                const content = typeof o.content === 'string' ? o.content.trim() : typeof o.text === 'string' ? o.text.trim() : '';
                return { title, content };
            })
            .filter(o => o.content || o.title);
        return options.length > 0 ? options : null;
    } catch {
        return null;
    }
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
    const GAP_RE = /^(?:[^\S\r\n]|\p{Extended_Pictographic}(?:\uFE0F|\u200D|\u20E3|\p{Emoji_Modifier})*)*$/u;
    const matches = [...text.matchAll(TITLE_RE)];
    if (matches.length === 0) {
        const trimmed = text.trim();
        return trimmed ? [{ title: '', content: trimmed }] : [];
    }

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
 * 括号回退。count 截断（模型超发时只取前 N 条）。
 */
export function parseOptions(text: string, count: number): ParseReport {
    let c = stripReasoning(String(text ?? ''));
    c = extractOptionsBlock(c);
    c = stripCodeFence(c);
    if (!c) return { path: 'empty', options: [] };

    // 单对象包裹形态（契约是数组但模型偶发 {"options":[...]}）：解出数组走主路径
    if (c.startsWith('{')) {
        try {
            const obj = JSON.parse(fixTrailingCommas(c)) as Record<string, unknown>;
            if (Array.isArray(obj?.options)) {
                const json = parseJsonArray(JSON.stringify(obj.options));
                if (json) return { path: 'json', options: json.slice(0, count) };
            }
        } catch {
            // 落回退
        }
    }
    if (c.startsWith('[')) {
        const json = parseJsonArray(c);
        if (json) return { path: 'json', options: json.slice(0, count) };
    }
    const fallback = parseBracketFallback(c);
    if (fallback.length === 0) return { path: 'empty', options: [] };
    return { path: 'bracket_fallback', options: fallback.slice(0, count) };
}

/**
 * 调试固定畸形样本（批B 判据：调试开关强制喂畸形输出，断言回退解析
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
