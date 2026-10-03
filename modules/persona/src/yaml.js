// YAML 人设文本解析：按顶层键切分为区块 Map。生产消费方＝generation.js 的 schema
// 判定与 prefill 首键派生；tests/yaml.test.js 锁解析契约。除诊断出口 log 外零依赖。
import { error as logError } from "./log.js";
// ============================================================================
// 数据解析
// ============================================================================

export function parseYamlToBlocks(text) {
    const map = new Map();
    if (!text || typeof text !== 'string') return map;
    try {
        const cleanText = text.replace(/^```[a-z]*\n?/im, '').replace(/```$/im, '').trim();
        let lines = cleanText.split('\n');
        const topLevelKeyRegex = /^\s*([^:\s\-]+?)\s*[:：]/;
        let topKeysIndices = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.length < 200 && topLevelKeyRegex.test(line) && !line.trim().startsWith('-') && line.search(/\S|$/) === 0) {
                topKeysIndices.push(i);
            }
        }
        if (topKeysIndices.length === 1 && lines.length > 2) {
            const firstLineIndex = topKeysIndices[0];
            const remainingLines = lines.slice(firstLineIndex + 1);
            let minIndent = Infinity;
            let hasContent = false;
            for (const l of remainingLines) {
                if (l.trim().length > 0) {
                    const indent = l.search(/\S|$/);
                    if (indent < minIndent) minIndent = indent;
                    hasContent = true;
                }
            }
            if (hasContent && minIndent > 0 && minIndent !== Infinity) {
                lines = remainingLines.map(l => l.length >= minIndent ? l.substring(minIndent) : l);
            }
        }
        let currentKey = null;
        let currentBuffer = [];
        const flushBuffer = () => {
            if (currentKey && currentBuffer.length > 0) {
                let valuePart = "";
                const firstLine = currentBuffer[0];
                const match = firstLine.match(topLevelKeyRegex);
                if (match) {
                    let inlineContent = firstLine.substring(match[0].length).trim();
                    let blockContent = currentBuffer.slice(1).join('\n');
                    if (inlineContent && blockContent) valuePart = inlineContent + '\n' + blockContent;
                    else if (inlineContent) valuePart = inlineContent;
                    else valuePart = blockContent;
                } else {
                    valuePart = currentBuffer.join('\n');
                }
                map.set(currentKey, valuePart);
            }
        };
        lines.forEach((line) => {
            const isTopLevel = (line.length < 200) && topLevelKeyRegex.test(line) && !line.trim().startsWith('-');
            const indentLevel = line.search(/\S|$/);
            if (isTopLevel && indentLevel <= 1) {
                flushBuffer();
                const match = line.match(topLevelKeyRegex);
                currentKey = match[1].trim();
                currentBuffer = [line];
            } else {
                if (currentKey) { currentBuffer.push(line); }
            }
        });
        flushBuffer();
    } catch (e) { logError("Parse Error:", e); }
    return map;
}
