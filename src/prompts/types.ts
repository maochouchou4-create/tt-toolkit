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
    | 'baibai'
    | 'pool_entries';

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
 * ExternalInjectionConfig 决定（allSlots 全搬或 selectedSlots 旧白名单），
 * 与模块定义解耦。
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
 * 分组只决定呈现位置——模块仍共用同一条 order 管线，排序语义不变。
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

/** 外部注入搬运配置（可选模块，默认关——方案 §2.3）。 */
export interface ExternalInjectionConfig {
    /**
     * 全部搬入模式（用户拍板 m02276：不做逐槽位勾选——「勾选柏宝书还要
     * 自己挑其中的内容，没必要」）：true＝在场槽位全搬；false＝走
     * selectedSlots 白名单（旧数据兼容路径，UI 已不暴露逐槽位勾选）。
     */
    allSlots: boolean;
    /** 宿主通用注入槽位：搬入的槽位 key 列表（allSlots=false 时生效的旧路径） */
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
