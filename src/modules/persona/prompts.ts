/**
 * PersonaWeaver fork 默认模版（纯数据，只读真源）。
 *
 * MODIFICATIONS（相对上游 fork）：策展/生成提示词正文
 * （DEFAULT_PROMPTS.curator / personaGen）迁入统一提示词引擎默认模板
 * （src/prompts/defaults.ts 的 PERSONA_CURATOR_PROMPT / PERSONA_GEN_PROMPT，
 * 正文零改动平移）；本文件只保留人设 YAML 模版（策展失败回退的
 * schema 骨架）。模版为纯静态骨架——不含任何宏占位符。
 */

export const DEFAULT_TEMPLATES = {
    // 默认 User 模版 (主模版)。与策展参考模块的「几乎必选」块对齐（基本
    // 信息/外貌/性格），性格块＝核心矛盾/情绪反应/说话风格三叶；基本信息
    // 只剩年龄/性别/身份（自称/称呼习惯删除——User 锚定由指令层承担，不靠
    // 字段）。不设姓名字段（User＝使用者本人，指令层已锚定）。刻意不设
    // 「现状」类动态字段：随剧情流动的状态由世界书与对话承担，写进静态人设
    // 既重复又会过时。不设小动作习惯类表演细节叶：细节密度由策展指令整体
    // 档位统一收口。与策展清单的对齐由冒烟骨架双源机判锁定（smoke.ts 对比
    // DEFAULT_TEMPLATES.user 性格叶与策展清单性格行），改任一侧漏改另一侧
    // 即翻红。
    user:
`基本信息:
  年龄:
  性别:
  身份:
外貌:
  整体印象:
  标志性特征:
  穿着习惯:
性格:
  核心矛盾:
  情绪反应:
  说话风格:
喜恶:
  喜欢:
  讨厌:
背景:
  来历:`,
} as const;

