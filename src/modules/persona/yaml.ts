/**
 * PersonaWeaver fork YAML 人设文本解析（批D 平移，纯函数）。
 *
 * MODIFICATIONS（相对上游 fork）：log.js 依赖改为静默容错（parse 失败返回
 * 空 Map，调用方按「不可解析」处理）——原 console.error 出口在 tab 内
 * 由调用方 toast 呈现。解析契约（顶层键切块、单顶层键整块去缩进）不变。
 */

/** 顶层键行（行长上限 200、非列表项、行首无缩进才认定为块界）。 */
const TOP_LEVEL_KEY_RE = /^\s*([^:\s\-]+?)\s*[:：]/;

/**
 * 按顶层键切分为区块 Map（键 → 块值，含首行内联值 + 余行）。
 * 生产消费方：generation 的 schema 判定（块数 > 0 即可解析）与
 * prefill 首键派生；smoke 锁解析契约。
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
            if (line.length < 200 && TOP_LEVEL_KEY_RE.test(line) && !line.trim().startsWith('-') && line.search(/\S|$/) === 0) {
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
                const match = firstLine.match(TOP_LEVEL_KEY_RE);
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
            const isTopLevel = line.length < 200 && TOP_LEVEL_KEY_RE.test(line) && !line.trim().startsWith('-');
            const indentLevel = line.search(/\S|$/);
            if (isTopLevel && indentLevel <= 1) {
                flushBuffer();
                currentKey = (line.match(TOP_LEVEL_KEY_RE) as RegExpMatchArray)[1].trim();
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
