// yaml.parseYamlToBlocks 输入输出契约：区块切分/围栏剥离。
// 只测导出接口，不为测试导出私有函数（拍板）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYamlToBlocks } from "../src/yaml.js";

test("非字符串输入返回空 Map", () => {
    assert.deepEqual(parseYamlToBlocks(null), new Map());
    assert.deepEqual(parseYamlToBlocks(undefined), new Map());
    assert.deepEqual(parseYamlToBlocks(42), new Map());
});

test("剥离 ``` 围栏后按键切分区块", () => {
    const text = "```yaml\n姓名: 小明\n描述: 一个测试\n```";
    const blocks = parseYamlToBlocks(text);
    assert.deepEqual([...blocks.keys()], ["姓名", "描述"]);
    assert.equal(blocks.get("姓名"), "小明");
    assert.equal(blocks.get("描述"), "一个测试");
});

test("多行值整块归入所属键，后续键正确切分", () => {
    const text = ["姓名: 小明", "外貌:", "  - 银发", "  - 红瞳", "性格: 温柔"].join("\n");
    const blocks = parseYamlToBlocks(text);
    assert.deepEqual([...blocks.keys()], ["姓名", "外貌", "性格"]);
    assert.equal(blocks.get("外貌"), "  - 银发\n  - 红瞳");
    assert.equal(blocks.get("性格"), "温柔");
});

test("键后同行值与缩进续行拼接为同一值", () => {
    const text = ["姓名: 小明", "描述: 简介", "  补充行"].join("\n");
    const blocks = parseYamlToBlocks(text);
    assert.equal(blocks.get("描述"), "简介\n  补充行");
});

test("全角冒号键正常切分", () => {
    const blocks = parseYamlToBlocks("姓名：小明");
    assert.equal(blocks.get("姓名"), "小明");
});

test("无键文本返回空 Map", () => {
    const blocks = parseYamlToBlocks("just some text\nno keys here");
    assert.equal(blocks.size, 0);
});
