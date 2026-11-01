/**
 * 风格池类型定义。
 *
 * 池是单层结构：masterPool 即全部内容，唯一样式随 default-pool.json
 * 资产发布、用户只读。池的内容形态＝纯风格名（单字段 name）：名字套到
 * 任意场面都成立，由提示词层把风格轴写成选项正文。抽签＝纯随机不放回，
 * 多抽候选让模型挑贴合的（菜单模式）——无固定席、无分类。
 */

/** 池条目（内容层，全局唯一真相源）。 */
export interface PoolEntry {
    /** 稳定 id（asset 池为 asset-<序号>，确定性映射）。 */
    id: string;
    /** 风格名（渲染为候选风格的编号行内容）。 */
    name: string;
}

/** 全局抽取参数（挂在 choice 域 gen 下，与 count 等生成参数同级）。 */
export interface PoolGenParams {
    /** 候选倍率百分比（值域单源＝pool/resolver 的 OVERSAMPLE_LIMITS）。菜单模式：多抽候选让 AI 挑。 */
    oversamplePct: number;
    /** MESSAGE_RECEIVED 自动生成总开关。 */
    autoGenerate: boolean;
}
