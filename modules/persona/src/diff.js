// 润色对比视图域：LCS 块计算、内联渲染与结果组装。
// 渲染只服务本域（#pw-diff-merge-list），视图状态在 store.currentDiffBlocks。
import { store } from "./state.js";
import { TEXT } from "./strings.js";
import { escapeHtml } from "./html.js";

// ============================================================================
// ============================================================================


export function computeDiffBlocks(oldText, newText) {
    const tokenize = (text) => {
        const tokens = [];
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
    };

    const oldArr = tokenize(oldText);
    const newArr = tokenize(newText);
    let m = oldArr.length, n = newArr.length;

    let dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldArr[i - 1] === newArr[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
            else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }

    let i = m, j = n;
    let result = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldArr[i - 1] === newArr[j - 1]) {
            result.unshift({ type: 'equal', value: oldArr[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({ type: 'insert', value: newArr[j - 1] });
            j--;
        } else {
            result.unshift({ type: 'delete', value: oldArr[i - 1] });
            i--;
        }
    }

    let blocks = [];
    let currentBlock = null;
    result.forEach(r => {
        if (r.type === 'equal') {
            if (currentBlock) { blocks.push(currentBlock); currentBlock = null; }
            blocks.push({ type: 'equal', value: r.value });
        } else {
            if (!currentBlock) currentBlock = { type: 'diff', oldText: '', newText: '', active: 'new' };
            if (r.type === 'delete') currentBlock.oldText += r.value;
            if (r.type === 'insert') currentBlock.newText += r.value;
        }
    });
    if (currentBlock) blocks.push(currentBlock);
    return blocks;
}

export function renderDiffComparison(oldText, newText) {
    store.currentDiffBlocks = computeDiffBlocks(oldText, newText);
    renderInlineDiff();
    $('#pw-diff-merge-list').removeClass('pw-diff-mode-new pw-diff-mode-old pw-diff-mode-final').addClass('pw-diff-mode-all');
    $('.pw-diff-mode-btn').removeClass('active');
    $('#pw-diff-hint').show();
}

function renderInlineDiff() {
    let html = '';
    store.currentDiffBlocks.forEach((block, index) => {
        if (block.type === 'equal') {
            html += `<span class="pw-idiff-equal" data-idx="${index}">${escapeHtml(block.value)}</span>`;
        } else {
            const isActiveOld = block.active === 'old';
            const isActiveNew = block.active === 'new';
            html += `<span class="pw-diff-group" data-index="${index}">`;
            if (block.oldText) {
                html += `<span class="pw-idiff-old ${isActiveOld ? 'active' : 'inactive'}" contenteditable="${isActiveOld ? 'true' : 'false'}" data-idx="${index}" title="点击保留旧版">${escapeHtml(block.oldText)}</span>`;
            }
            if (block.newText) {
                html += `<span class="pw-idiff-new ${isActiveNew ? 'active' : 'inactive'}" contenteditable="${isActiveNew ? 'true' : 'false'}" data-idx="${index}" title="点击保留新版">${escapeHtml(block.newText)}</span>`;
            }
            html += `</span>`;
        }
    });

    const $container = $('#pw-diff-merge-list');
    $container.attr('contenteditable', 'true').html(html);

    let changeCount = store.currentDiffBlocks.filter(b => b.type === 'diff').length;
    if (changeCount === 0) toastr.info(TEXT.TOAST_NO_CHANGES);
}

export function assembleDiffResult() {
    let text = '';
    store.currentDiffBlocks.forEach(block => {
        if (block.type === 'equal') {
            text += block.value;
        } else if (block.active === 'old') {
            text += block.oldText;
        } else {
            text += block.newText;
        }
    });
    return text;
}
