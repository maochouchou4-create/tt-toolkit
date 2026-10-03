// diff.computeDiffBlocks 输入输出契约：等块/增删块。
// 只测导出接口；token 按标点切分且标点附着于前段，增删段合并为单个 diff 块。
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDiffBlocks } from "../src/diff.js";

test("相同文本产出全等块，拼接还原原文", () => {
    const blocks = computeDiffBlocks("你好。再见。", "你好。再见。");
    assert.ok(blocks.every((b) => b.type === "equal"));
    assert.equal(blocks.map((b) => b.value).join(""), "你好。再见。");
});

test("纯新增产出单块 diff，active 默认 new", () => {
    const blocks = computeDiffBlocks("", "新内容。");
    assert.deepEqual(blocks, [{ type: "diff", oldText: "", newText: "新内容。", active: "new" }]);
});

test("纯删除产出单块 diff，newText 为空", () => {
    const blocks = computeDiffBlocks("旧内容。删除掉。", "");
    assert.deepEqual(blocks, [{ type: "diff", oldText: "旧内容。删除掉。", newText: "", active: "new" }]);
});

test("整句改写合并为一块增删对", () => {
    const blocks = computeDiffBlocks("你好。", "你好呀。");
    assert.deepEqual(blocks, [{ type: "diff", oldText: "你好。", newText: "你好呀。", active: "new" }]);
});

test("等块与增删块交错输出", () => {
    const blocks = computeDiffBlocks("你好。再见。", "你好。拜拜。");
    assert.deepEqual(blocks, [
        { type: "equal", value: "你好。" },
        { type: "diff", oldText: "再见。", newText: "拜拜。", active: "new" },
    ]);
});
