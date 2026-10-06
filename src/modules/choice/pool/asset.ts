/**
 * 内置池资产：default-pool.json 是条目池的唯一真相源，
 * 内容随插件仓库发布（编辑走 git 更新链，用户在 UI 里只读浏览）。
 *
 * 同步策略：启动时（initChoice / initChoiceMinimal）以 asset 覆盖存储里的
 * 内容域——masterPool 全量重建；用户域只剩运行时开关（gen 的
 * autoGenerate/categoriesEnabled 等），syncAssetPool 不碰（唯一例外见
 * 首次同步注释）。assetVersion 标记使重复启动零写入（幂等快路径）。
 */
import assetJson from './default-pool.json';
import type { PoolEntry } from './types';
import type { PoolDomainData } from './normalize';
import { safeWeight } from './resolver';
import { choiceStorage } from '../api';

/** default-pool.json 的静态形状（构建产物，自身可信；normalize 只为防御）。 */
interface PoolAsset {
    version: number;
    entries: Array<{
        type: string;
        content: string;
        category: string;
        pinned?: boolean;
        weight?: number;
    }>;
}

const asset = assetJson as unknown as PoolAsset;

/** asset 版本（default-pool.json 顶层 version；smoke 断言引用，避免硬编码漂移）。 */
export const ASSET_POOL_VERSION: number = asset.version;

/**
 * asset → 运行时池形状的确定性映射：条目 id=asset-<序号>（顺序即 json 顺序，
 * 不掺时间/随机——同一份 json 永远映射出同一池，幂等重写不产生 diff 噪声）。
 */
export function buildAssetPool(): Pick<PoolDomainData, 'masterPool'> {
    const masterPool: PoolEntry[] = asset.entries.map((e, i) => ({
        id: `asset-${i + 1}`,
        type: e.type,
        content: e.content,
        category: e.category,
        pinned: e.pinned ?? false,
        weight: safeWeight(e.weight),
    }));
    return { masterPool };
}

/**
 * 以 asset 覆盖存储内容域。幂等：assetVersion 已是当前版本时直接返回（零写入）。
 *
 * 首次同步（assetVersion 非 number，含旧用户/全新安装）额外做一次性 gen 翻转：
 * categoriesEnabled false→true——批C.2 拍板「按分类轮询默认开」，旧档的 false
 * 是旧默认值而非用户选择。此后 gen 纯用户域，用户关掉不会被任何同步回翻。
 */
export function syncAssetPool(): void {
    choiceStorage.writeDomain(d => {
        if (d.pool.assetVersion === asset.version) return;
        const firstSync = typeof d.pool.assetVersion !== 'number';
        const { masterPool } = buildAssetPool();
        d.pool = { masterPool, assetVersion: asset.version };
        if (firstSync && !d.gen.categoriesEnabled) {
            d.gen.categoriesEnabled = true;
        }
    });
}
