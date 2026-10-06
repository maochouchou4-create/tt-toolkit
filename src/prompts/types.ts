/**
 * 提示词子系统类型。
 *
 * 统一单条模块管线：文本模块（规则/任务/格式）与注入模块（人设/角色卡/
 * 世界书/历史/外部搬运）同一条 order 排序——单一排序契约，不分两套列表。
 * 提示词单一真相源＝configs[] 每套自带 modules[]，无工作副本无快照
 * 双份。编辑面已删——模板内置在代码（defaults），
 * 引擎照常读 modules；enabled 字段保留（引擎行为面）。
 */

/** 消息角色三态（不拼单段塞单条消息——role 结构是架构约束）。 */
export type PromptRole = 'system' | 'user' | 'assistant';

/**
 * 提示词任务键（引擎多任务化）。各生成管线各自持一套
 * PromptConfig——choice（选项生成）与 persona 两段（策展 schema、按
 * schema 填充人设）。存储形态 Record<taskKey, PromptConfig>。
 */
export type TaskKey = 'choice' | 'persona_curator' | 'persona_gen';

/** 全部任务键（读侧补缺/迁移遍历用）。 */
export const TASK_KEYS: readonly TaskKey[] = ['choice', 'persona_curator', 'persona_gen'];

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
    // ---- persona 任务注入源——内容在 PersonaAssemblySources ----
    /** persona 世界书参考（独立 system 消息，XiTa 式围栏包装）。预设 system 段
     *  源已随任务级预设选择退役（破限预设统一走传输层注入，见 apis/preset-inject）。 */
    | 'persona_wi';
    // 角色卡信息/开场白/用户请求/策展 schema 四件不再走注入源：数据面字段
    // 在 PersonaAssemblySources、占位符填充链（fillPersonaPlaceholders）
    // 独立存活。

/**
 * persona 任务的注入源集合（判别/分流用）。as const 数组＝单一真相源：
 * engine 的判别集合由此派生，union 由数组派生，无双份维护面。
 */
export const PERSONA_INJECTION_SOURCES = [
    'persona_wi',
] as const;

export type PersonaInjectionSource = (typeof PERSONA_INJECTION_SOURCES)[number];

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
 * 引擎行为面消费（默认模板内置；无编辑 UI）。
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

/** 提示词配置集（单一真相源：每套自带 modules[]）。 */
export interface PromptConfig {
    id: string;
    name: string;
    modules: PromptModule[];
    /** 写入时的默认模板版本——default 配置据此被版本化重建（storage 层），定制配置可缺席。 */
    defaultsVersion?: number;
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
