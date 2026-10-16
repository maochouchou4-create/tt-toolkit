/**
 * PersonaWeaver fork 默认模版（纯数据，只读真源）。
 *
 * MODIFICATIONS（相对上游 fork）：策展/生成提示词正文
 * （DEFAULT_PROMPTS.curator / personaGen）已迁入统一提示词引擎默认模板
 * （src/prompts/defaults.ts 的 PERSONA_CURATOR_PROMPT / PERSONA_GEN_PROMPT，
 * 策展段整段按策展目录重写、生成段局部口径传导，已不是 fork 原文）；本
 * 文件只保留人设 YAML 模版（策展失败回退的 schema 骨架），骨架由策展目录
 * 的骨架标记推导——骨架与策展清单从此是同一份数据，目录外的键再也塞不进
 * 回退骨架。模版为纯静态骨架——不含任何宏占位符。
 */
import { renderSkeletonYaml } from '@/modules/persona/catalog';

export const DEFAULT_TEMPLATES = {
    // 默认 User 模版 (主模版)。策展失败回退的 schema 骨架——取目录里带
    // 骨架标记的叶：回退物要的是「任何题材都填得满」的最小集，条件式块
    // （题材不到就没有内容）默认不进骨架，缺素材就只能编。不设姓名字段
    // （User＝使用者本人，指令层已锚定）；刻意不设「现状」类动态字段：
    // 随剧情流动的状态由世界书与对话承担，写进静态人设既重复又会过时。
    // 骨架的块与叶键名由冒烟逐块同字面量比对锁定（smoke.ts），改目录的
    // 骨架标记而不改期望值即翻红。
    user: renderSkeletonYaml(),
} as const;
