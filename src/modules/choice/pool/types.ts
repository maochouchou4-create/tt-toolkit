/**
 * 条目池类型定义。
 *
 * 池是单层结构：masterPool 即全部内容（type/content/category/pinned
 * 都在条目自身），唯一样式随 default-pool.json 资产发布、用户只读。
 * 规则概念已整体删除（条目级 v2 弃、池级 v3 弃）——反 OOC
 * 约束并入提示词模板 core_rules，池数据不再携带任何规则字段。
 */

/**
 * 池分类名单唯一真源：与 default-pool.json 的 category 集合一致（改池分类＝
 * 改 JSON＋同步本表，两个方向漏一边都由 choice/smoke.ts 的名单全等断言拦下）。
 * 写错分类名从此有类型与冒烟两道机器闸。
 */
export const POOL_CATEGORIES = [
    '接住对方',
    '关系走法',
    '言语走法',
    '身体行动',
    '局面推进',
    '外部变化',
    '节奏调度',
    '视角形式',
    'NSFW',
] as const;

/** 池分类名（POOL_CATEGORIES 成员的联合）。 */
export type PoolCategory = (typeof POOL_CATEGORIES)[number];

/** 池条目（内容层，全局唯一真相源）。 */
export interface PoolEntry {
    /** 稳定 id（asset 池为 asset-<序号>，确定性映射）。 */
    id: string;
    /** 条目标题（渲染为选项的 type 前缀）。 */
    type: string;
    /** 条目正文（交给 AI 的候选素材）。 */
    content: string;
    /** 默认分类（分组轮询的桶键；名单见 POOL_CATEGORIES，坏档容忍见 normalize）。 */
    category: PoolCategory;
    /** 固定条目（每轮必发，不参与抽签）。 */
    pinned: boolean;
}

/** pinned 条目数超出 gen.count 时的处理策略。 */
export type PinnedOverflow = 'send_all' | 'trim';

/** 全局抽取参数（挂在 choice 域 gen 下，与 count 等生成参数同级）。 */
export interface PoolGenParams {
    /** 候选条目超额抽取百分比（值域单源＝pool/resolver 的 OVERSAMPLE_LIMITS）。菜单模式：多抽候选让 AI 挑。 */
    oversamplePct: number;
    /** 按 category 分桶轮询（桶序随机、桶内等权）。 */
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
    /** 候选区（等权抽取，数量受 oversamplePct 影响）。 */
    drawn: PoolEntry[];
}

/** 注入给提示词引擎的池快照（generator 现场抽取后传入，prompts 层只消费不回读）。 */
export interface PoolInjection {
    /** 必发区条目。 */
    pinned: PoolEntry[];
    /** 候选区条目（菜单模式：数量可多于实际所需）。 */
    drawn: PoolEntry[];
}
