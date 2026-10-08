/**
 * PersonaWeaver fork YAML 人设文本解析（纯函数）。
 *
 * MODIFICATIONS（相对上游 fork）：log.js 依赖改为静默容错（parse 失败返回
 * 空 Map，调用方按「不可解析」处理）——原 console.error 出口在 tab 内
 * 由调用方 toast 呈现。解析契约（顶层键切块、单顶层键整块去缩进）不变。
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
 * 切块边界判定（**唯一定义**：parseYamlToBlocks 的开块与 isSchemaSkeleton
 * 的「此行会开一个新块」都用它）——宽松键行、非列表项、缩进 ≤1。
 *
 * 为什么必须有这一处共同定义：两个消费方曾各自内联条件（切块写
 * `KEY_LINE_RE && indentLevel <= 1`、校验写「缩进行一律从宽」），于是
 * 「 备注，注意如下:」这类 1 空格缩进、键名带标点的行被判据放行、却被切块
 * 当成新顶层块——校验说「这是骨架」，切块给出的却不是它看到的形状。
 * 两边共用本函数后，「什么算块界」只有一个答案。
 *
 * 缩进 ≤1（而非 ===0）是既有切块契约的容忍度：模型常用 1 空格缩进子键，
 * 按块界处理可把 schema 摊平；改动它会波及单顶层键去缩进修复，不在本处
 * 职责内。
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
        const cleanText = text.replace(/^```[a-z]*\n?/im, '').replace(/```$/im, '').trim();
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
    const cleanText = text.replace(/^```[a-z]*\n?/im, '').replace(/```$/im, '').trim();
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
