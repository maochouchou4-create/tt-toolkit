// DEFAULT_TEMPLATES.user 的结构契约：顶层块清单与顺序、每块叶子字面清单、{{user}} 占位符、可解析性；DEFAULT_PROMPTS 的占位符组装契约。
// 只测结构不测内容语义——正文是提示词工程的常态迭代区，逐字断言会让每次调优都变红。
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TEMPLATES, DEFAULT_PROMPTS } from "../src/prompts.js";
import { parseYamlToBlocks } from "../src/yaml.js";

// 顶层块顺序即展示顺序，六块与 curator 的 base_blocks 对齐。
// 增删块须同批改此处与 src/prompts.js 两处。
const EXPECTED_BLOCKS = ["基本信息", "外貌", "性格", "背景", "喜恶", "NSFW"];
// 每块叶子字面清单（结构钉死，不测值）。增删叶须同批改 src/prompts.js 的模板正文。
const EXPECTED_LEAVES = {
    基本信息: ["姓名", "年龄", "性别", "身份", "自称", "对他人的称呼"],
    外貌: ["概貌", "标志性特征", "穿着习惯"],
    性格: ["核心特质", "矛盾点", "表里反差", "情绪反应", "小动作习惯", "说话风格", "口头禅", "在乎与害怕", "底线与禁忌"],
    背景: ["来历一句话"],
    喜恶: ["喜欢", "讨厌"],
    NSFW: ["基本倾向", "禁忌底线"]
};

test("顶层块恰为既定清单且顺序一致", () => {
    const blocks = parseYamlToBlocks(DEFAULT_TEMPLATES.user);
    assert.deepEqual([...blocks.keys()], EXPECTED_BLOCKS);
});

test("每块叶子恰为既定清单", () => {
    const blocks = parseYamlToBlocks(DEFAULT_TEMPLATES.user);
    for (const name of EXPECTED_BLOCKS) {
        const lines = blocks.get(name).split("\n").filter((line) => line.trim().length > 0);
        const leaves = lines
            .map((line) => { const m = line.match(/^\s*([^:：]+)[:：]/); return m ? m[1].trim() : null; })
            .filter(Boolean);
        assert.deepEqual(leaves, EXPECTED_LEAVES[name], `${name} 的叶子清单不符`);
        // 防畸形叶漏检：叶子靠冒号切名，无冒号的非空行会被静默丢弃——直接判红
        assert.equal(leaves.length, lines.length, `${name} 存在无冒号的行`);
    }
});

test("含 {{user}} 占位符", () => {
    assert.ok(DEFAULT_TEMPLATES.user.includes("{{user}}"));
});

test("parseYamlToBlocks 可解析出全部顶层块", () => {
    const blocks = parseYamlToBlocks(DEFAULT_TEMPLATES.user);
    assert.equal(blocks.size, EXPECTED_BLOCKS.length);
});

test("personaGen 含全部组装占位符", () => {
    for (const key of ["user", "charInfo", "greetings", "template", "input"]) {
        assert.ok(DEFAULT_PROMPTS.personaGen.includes(`{{${key}}}`), `personaGen 缺 {{${key}}}`);
    }
});

test("curator 含组装占位符", () => {
    for (const key of ["charInfo", "userRequirements"]) {
        assert.ok(DEFAULT_PROMPTS.curator.includes(`{{${key}}}`), `curator 缺 {{${key}}}`);
    }
});
