/**
 * PersonaWeaver fork 润色对比域（批D 平移）：LCS 块计算与结果组装。
 *
 * MODIFICATIONS（相对上游 fork）：
 * - 砍 renderDiffComparison/renderInlineDiff（jQuery+contenteditable 渲染
 *   整体退役，diff 取舍视图由 PersonaTab.vue 以 Vue 响应式块渲染）。
 * - computeDiffBlocks/assembleDiffResult 纯函数原样平移；active 取舍状态
 *   移入块对象本身（'old'|'new'），tab 内直接改块属性触发响应式更新。
 */

/** equal 块（两文本共有片段）。 */
export interface DiffEqualBlock {
    type: 'equal';
    value: string;
}

/** diff 块（删除+插入合并；active＝取舍态，'new' 为默认采纳侧）。 */
export interface DiffMergeBlock {
    type: 'diff';
    oldText: string;
    newText: string;
    active: 'old' | 'new';
}

export type DiffBlock = DiffEqualBlock | DiffMergeBlock;

/** 按中英文句读分隔符分词（分隔符归入前 token）。 */
function tokenize(text: string): string[] {
    const tokens: string[] = [];
    let current = '';
    for (let i = 0; i < text.length; i++) {
        current += text[i];
        if (/[，。！？；\n,.!?;：]/.test(text[i])) {
            tokens.push(current);
            current = '';
        }
    }
    if (current) tokens.push(current);
    return tokens;
}

/**
 * 块级 diff（LCS 动态规划回溯）：token 序列对齐 → equal/insert/delete →
 * 相邻 delete+insert 合并为 {oldText,newText,active:'new'} 块。
 */
export function computeDiffBlocks(oldText: string, newText: string): DiffBlock[] {
    const oldArr = tokenize(oldText);
    const newArr = tokenize(newText);
    const m = oldArr.length;
    const n = newArr.length;

    // LCS 长度表（1-based，dp[0][*]=dp[*][0]=0）
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldArr[i - 1] === newArr[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
            else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }

    // 回溯取对齐序列（头部插入）
    let i = m;
    let j = n;
    const result: Array<{ type: 'equal' | 'insert' | 'delete'; value: string }> = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldArr[i - 1] === newArr[j - 1]) {
            result.unshift({ type: 'equal', value: oldArr[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({ type: 'insert', value: newArr[j - 1] });
            j--;
        } else {
            result.unshift({ type: 'delete', value: oldArr[i - 1] });
            i--;
        }
    }

    // 相邻 delete/insert 合并为一个取舍块
    const blocks: DiffBlock[] = [];
    let currentBlock: DiffMergeBlock | null = null;
    result.forEach(r => {
        if (r.type === 'equal') {
            currentBlock = null;
            blocks.push({ type: 'equal', value: r.value });
        } else {
            if (!currentBlock) {
                currentBlock = { type: 'diff', oldText: '', newText: '', active: 'new' };
                blocks.push(currentBlock);
            }
            if (r.type === 'delete') currentBlock.oldText += r.value;
            if (r.type === 'insert') currentBlock.newText += r.value;
        }
    });
    return blocks;
}

/** 组装修改后的全文（equal 拼值 + diff 块按 active 取 old/new）。 */
export function assembleDiffResult(blocks: DiffBlock[]): string {
    let text = '';
    for (const block of blocks) {
        if (block.type === 'equal') {
            text += block.value;
        } else if (block.active === 'old') {
            text += block.oldText;
        } else {
            text += block.newText;
        }
    }
    return text;
}
