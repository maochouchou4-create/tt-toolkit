/**
 * 提示词子系统类型（方案 §2.3）。
 *
 * 统一单条模块管线：文本模块（规则/任务/格式）与注入模块（人设/角色卡/
 * 世界书/历史/外部搬运）同一条 order 排序——单一排序契约，不分两套列表。
 * 提示词单一真相源＝configs[] 每套自带 modules[]，无工作副本无快照
 * 双份（编辑器直接编辑当前生效配置）。
 */

/** 消息角色三态（不拼单段塞单条消息——role 结构是架构约束）。 */
export type PromptRole = 'system' | 'user' | 'assistant';

/**
 * 注入源标识。每个注入模块绑定一个源；源内容由组装时的
 * AssemblySources 提供（engine 纯函数消费，宿主数据由 sources 层收集）。
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
    | 'baibai';

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
 * 注入模块：内容来自运行时上下文，不可编辑文本（可调启停/顺序/role）。
 * 槽位选择不在本类型（双语义残留已清）：external_slot 源搬哪些槽位由
 * ExternalInjectionConfig.selectedSlots 决定，与模块定义解耦。
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
}

/** 剧情走向标签（六选一起步，方案 §7 P-走向；''＝放任自流不注入）。 */
export type StoryDirectionTag = 'advance' | 'conflict' | 'warm' | 'suspense' | 'foreshadow' | 'free';

export interface StoryDirectionTagDef {
    id: StoryDirectionTag;
    label: string;
    /** 注入给模型的走向指令（free 不注入，guidance 不消费） */
    guidance: string;
}

/** 剧情趋向（chat 域：走向标签＋自由文本，答「剧情往哪走」）。 */
export interface StoryDirection {
    tag: StoryDirectionTag;
    freeText: string;
}

/** 外部注入搬运配置（可选模块，默认关——方案 §2.3）。 */
export interface ExternalInjectionConfig {
    /** 宿主通用注入槽位：勾选搬入的槽位 key 列表 */
    selectedSlots: string[];
    /** 柏宝书 STBaiBaiBook 摘要搬运开关 */
    baibai: boolean;
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
