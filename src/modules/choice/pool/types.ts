/**
 * 条目池两层结构的类型定义（批C）。
 *
 * 为什么分两层：master_pool 是内容唯一真相源（type/content/rule/category 只读于池层），
 * poolConfigs 是引用层（只决定「用哪些条目」并可覆盖 enabled/pinned/weight）——
 * 内容与配置分离后，多套配置可共享同一批条目，编辑正文不会波及配置。
 */

/** 池条目（内容层，全局唯一真相源）。 */
export interface PoolEntry {
    /** 稳定 id。旧版数据导入时统一 trim 规范化（原 id 部分带 \r）。 */
    id: string;
    /** 条目标题（渲染为选项的 type 前缀）。 */
    type: string;
    /** 条目正文（交给 AI 的候选素材）。 */
    content: string;
    /** 条目级写作约束（只约束该条如何写，不是选用门槛）。 */
    rule: string;
    /** 默认分类（分组轮询的桶键）。 */
    category: string;
    /** 池层默认 pinned（引用层可覆盖）。 */
    pinned: boolean;
    /** 池层默认权重（引用层可覆盖）。 */
    weight: number;
}

/** 池配置对单条条目的引用（覆盖层，不持有正文）。 */
export interface PoolConfigEntry {
    /** 指向 PoolEntry.id（已 trim 规范化）。 */
    entryId: string;
    /** false 时该条目不参与本次配置的抽取（未引用 ≠ 停用：未被引用只是不在池里）。 */
    enabled: boolean;
    /** 覆盖 pinned。 */
    pinned: boolean;
    /** 覆盖 weight。 */
    weight: number;
}

/** 池配置（引用层）。 */
export interface PoolConfig {
    id: string;
    name: string;
    /** 是否默认配置（绑定级联的兜底落点）。 */
    isDefault: boolean;
    /** 配置级写作规则（独立于模板 core_rules 的池规则段）。 */
    rules: string;
    /** 引用的条目及覆盖。 */
    entries: PoolConfigEntry[];
}

/** pinned 条目数超出 gen.count 时的处理策略。 */
export type PinnedOverflow = 'send_all' | 'trim';

/** 全局抽取参数（挂在 choice 域 gen 下，与 count 等生成参数同级——不是单配置字段）。 */
export interface PoolGenParams {
    /** 候选条目超额抽取百分比（0-300）。菜单模式：多抽候选让 AI 挑。 */
    oversamplePct: number;
    /** 按 category 分桶轮询（桶序随机、桶内加权）。 */
    categoriesEnabled: boolean;
    /** pinned 超发策略。 */
    pinnedOverflow: PinnedOverflow;
    /** 最终是否分别打乱 pinned / drawn。 */
    shuffleFinal: boolean;
    /** MESSAGE_RECEIVED 自动生成总开关。 */
    autoGenerate: boolean;
}

/** 一次抽取的结果。 */
export interface DrawResult {
    /** 必发区（pinned，全部保留或按策略截断）。 */
    pinned: PoolEntry[];
    /** 候选区（加权抽取，数量受 oversamplePct 影响）。 */
    drawn: PoolEntry[];
}

/** 注入给提示词引擎的池快照（generator 现场抽取后传入，prompts 层只消费不回读）。 */
export interface PoolInjection {
    /** 必发区条目（每条含 type/content/rule）。 */
    pinned: PoolEntry[];
    /** 候选区条目（菜单模式：数量可多于实际所需）。 */
    drawn: PoolEntry[];
    /** 生效池配置的 rules 原文（独立 pool_rules 段）。 */
    rules: string;
}
