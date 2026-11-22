/**
 * 宿主「聊天补全源 → 模型设置字段」分派表（双 harness 共享单源）。
 *
 * 真源＝宿主 D:\code\repos\TauriTavern\src\scripts\openai.js:2746
 * getChatCompletionModel 的分派形态（常用源子集；未映射源在两套存根里
 * 均返回 null＝未选模型，跟随判挡安全兜底）。宿主升级改分派时改这一处。
 *
 * 消费方：dev-harness/stubs.js（浏览器 harness 的 getChatCompletionModel
 * 存根）与 scripts/smoke.mjs（node 冒烟的 stubContext）——两套 harness
 * 运行时隔离（浏览器/纯 node），共享靠本模块物理单源，不靠互指注释。
 */
export const MODEL_FIELDS = {
    custom: 'custom_model',
    openai: 'openai_model',
    claude: 'claude_model',
    deepseek: 'deepseek_model',
    makersuite: 'google_model',
    google: 'google_model',
    mistralai: 'mistralai_model',
    openrouter: 'openrouter_model',
    xai: 'xai_model',
    zai: 'zai_model',
    moonshot: 'moonshot_model',
};
