// world-info.generateSmartKeywords 输入输出契约：关键词抽取。
// 本模块顶层读 localStorage（装载钉选书目到 store），由 tests/loader.mjs 的内存桩承载。
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSmartKeywords } from "../src/world-info.js";

test("姓名与静态标签直接入选", () => {
    assert.deepEqual(generateSmartKeywords("小明", "普通内容", ["主角"]), ["小明", "主角"]);
});

test("从内容的别名行抽取别名（支持中文逗号/顿号/英文逗号）", () => {
    const content = "姓名: 小明\n别名: 阿明、明明, 小暗";
    assert.deepEqual(generateSmartKeywords("小明", content), ["小明", "阿明", "明明", "小暗"]);
});

test("中圆点分隔的译名补充前半段", () => {
    assert.deepEqual(generateSmartKeywords("希尔薇·波拉", "内容"), ["希尔薇·波拉", "希尔薇"]);
});

test("空格分隔的西文名补充名字段，单字母名字段被过滤", () => {
    assert.deepEqual(generateSmartKeywords("John Doe", "内容"), ["John Doe", "John"]);
    assert.deepEqual(generateSmartKeywords("J D", "内容"), ["J D"]);
});

test("去重且剔除空值与单字符", () => {
    assert.deepEqual(generateSmartKeywords("小明", "内容", ["小明", ""]), ["小明"]);
});
