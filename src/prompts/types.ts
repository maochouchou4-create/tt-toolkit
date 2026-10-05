/**
 * 提示词子系统类型（方案 §2.3）。
 *
 * 统一单条模块管线：文本模块（规则/任务/格式）与注入模块（人设/角色卡/
 * 世界书/历史/外部搬运）同一条 order 排序——单一排序契约，不分两套列表。
 * 提示词单一真相源＝configs[] 每套自带 modules[]，无工作副本无快照
 * 双份。整合轮II 验收修整：编辑面已删——模板内置在代码（defaults），
 * 引擎照常读 modules；enabled 字段保留（引擎行为面）。
 */

/** 消息角色三态（不拼单段塞单条消息——role 结构是架构约束）。 */
export type PromptRole = 'system' | 'user' | 'assistant';

/**
 * 提示词任务键（整合轮II：引擎多任务化）。四条生成管线各自持一套
 * PromptConfig——choice（选项生成）与 persona 三段（策展 schema、按
 * schema 填充人设、润色现有人设）。存储形态 Record<taskKey, PromptConfig>。
 */
export type TaskKey = 'choice' | 'persona_curator' | 'persona_gen' | 'persona_refine';

/** 全部任务键（读侧补缺/迁移遍历用；顺序＝编辑器任务条的呈现顺序）。 */
export const TASK_KEYS: readonly TaskKey[] = ['choice', 'persona_curator', 'persona_gen', 'persona_refine'];

/**
 * 注入源标识。每个注入模块绑定一个源；源内容由组装时的
 * AssemblySources / PersonaAssemblySources 提供（engine 纯函数消费，
 * 宿主数据由 sources 层或各任务调用方收集）。
 */
export type InjectionSource =
    | 'persona'
    | 'char_description'
    | 'char_personality'
    | 'char_scenario'
    | 'world_info_before'
    | 'world_info_after'
    | 'wi_depth_before'
    | 'wi_depth_after'
    | 'chat_history'
    | 'story_direction'
    | 'external_slot'
    | 'baibai'
    | 'pool_entries'
    // ---- persona 任务注入源（整合轮II）——内容在 PersonaAssemblySources ----
    /** 生成用预设的 system 段（「纯净模式」＝空，模块跳过） */
    | 'persona_preset'
    /** persona 世界书参考（独立 system 消息，XiTa 式围栏包装） */
    | 'persona_wi'
    /** 角色卡全量信息文本（{{charInfo}} 占位符同源） */
    | 'char_info'
    /** 开场白参考（{{greetings}} 占位符同源） */
    | 'greetings'
    /** 用户请求/修补指令（{{input}}/{{userRequirements}} 占位符同源） */
    | 'user_request'
    /** 策展产出的 schema（{{template}} 占位符同源） */
    | 'curated_schema'
    /** 当前人设文本（refine 的修补基线） */
    | 'current_persona';

/** persona 任务的注入源集合（判别/分流用）。 */
export type PersonaInjectionSource =
    | 'persona_preset'
    | 'persona_wi'
    | 'char_info'
    | 'greetings'
    | 'user_request'
    | 'curated_schema'
    | 'current_persona';

/** choice 任务的注入源（persona 源之外的全部——engine 分流判别用）。 */
export type ChoiceInjectionSource = Exclude<InjectionSource, PersonaInjectionSource>;

/** 文本模块：用户可编辑的规则/任务/格式文本。 */
export interface TextModule {
    kind: 'text';
    id: string;
    name: string;
    role: PromptRole;
    order: number;
    enabled: boolean;
    content: string;
}

/**
 * 注入模块：内容来自运行时上下文，不可编辑文本。模块的启停与排序仅
 * 引擎行为面消费（默认模板内置；整合轮II 验收修整起无编辑 UI）。
 * external_slot 源带哪些槽位由全自动收集决定（sources 层枚举宿主
 * extension_prompts 非空槽位），与模块定义解耦。
 */
export interface InjectModule {
    kind: 'inject';
    id: string;
    name: string;
    role: PromptRole;
    order: number;
    enabled: boolean;
    source: InjectionSource;
}

export type PromptModule = TextModule | InjectModule;

/**
 * 编辑器信息架构分组（G5 拍板）：核心模板（文本模块）/上下文注入
 * （人设、角色卡、世界书、历史等现场数据）/高级（外部插件内容搬运）。
 * 整合轮II 验收修整：编辑面已删（分组无渲染消费方），保留纯函数与
 * ModuleGroupId 导出——数据层最小改动（smoke/导入面不破坏）。
 */
export type ModuleGroupId = 'text' | 'context_inject' | 'external_inject';

/** 模块的编辑器分组归属（纯函数，供分组渲染与组内相邻移动共用）。 */
export function moduleGroupOf(mod: PromptModule): ModuleGroupId {
    if (mod.kind === 'text') return 'text';
    return mod.source === 'external_slot' || mod.source === 'baibai' ? 'external_inject' : 'context_inject';
}

/** 提示词配置集（单一真相源：每套自带 modules[]）。 */
export interface PromptConfig {
    id: string;
    name: string;
    modules: PromptModule[];
}

/** 用户自建剧情走向预设（全局域；G4 拍板：自定义预设取代固定六标签）。 */
export interface DirectionPreset {
    id: string;
    /** 预设正文（应用后注入 <direction> 段的走向指令本体） */
    text: string;
}

/**
 * 剧情趋向（chat 域，答「剧情往哪走」）：已应用预设正文＋自由文本。
 * presetText 是应用时刻的快照——预设日后编辑/删除不影响已应用聊天
 * （快照自包含，无悬空引用）；两者皆空＝模块按未启用处理（不注入）。
 */
export interface StoryDirection {
    /** 已应用预设正文（空串＝未应用） */
    presetText: string;
    /** 自由补充文本（空串＝没有） */
    freeText: string;
}

/** 组装产物消息（与 host/generate 的 GenerateMessage 同构，层次内自持）。 */
export interface AssemblyMessage {
    role: PromptRole;
    content: string;
}

/**
 * 组装溯源（dump 断言依赖）：每模块注入与否＋跳过原因。
 * 用户验收靠它核对「人设/角色卡/世界书/story_direction 注入逐项可见」。
 */
export interface ModuleTrace {
    moduleId: string;
    moduleName: string;
    kind: 'text' | 'inject';
    source?: InjectionSource;
    injected: boolean;
    /** 未注入原因（空串＝已注入） */
    note: string;
}
