/**
 * 内置池资产：default-pool.json 是风格池的唯一真相源，
 * 内容随插件仓库发布（编辑走 git 更新链，用户在 UI 里只读浏览）。
 *
 * 收录纪律（作者侧）：一条＝一个风格名——名字套到任意场面都成立才是风格
 * （带场面细节的是条目不是风格）；语义近重的名字在收录时砍并，收录判定在作者侧。
 * 新条目只写 name；改池（增删改任何条目）必须 bump 顶层 version——
 * syncAssetPool 靠 version 判断是否重刷，不 bump 版本则改动永不落地。
 *
 * 同步策略：启动时（initChoice / initChoiceMinimal）以 asset 覆盖存储里的
 * 内容域——masterPool 全量重建；用户域（gen 的 autoGenerate/oversamplePct 等）
 * syncAssetPool 不碰。assetVersion 标记使重复启动零写入（幂等快路径）。
 */
import assetJson from './default-pool.json';
import type { PoolEntry } from './types';
import type { PoolDomainData } from './normalize';
import { choiceStorage } from '../api';

/** default-pool.json 的静态形状（构建产物，自身可信；normalize 只为防御）。 */
interface PoolAsset {
    version: number;
    entries: Array<{
        name: string;
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
        name: e.name,
    }));
    return { masterPool };
}

/**
 * 以 asset 覆盖存储内容域。幂等：assetVersion 已是当前版本时直接返回（零写入）。
 */
export function syncAssetPool(): void {
    choiceStorage.writeDomain(d => {
        if (d.pool.assetVersion === asset.version) return;
        const { masterPool } = buildAssetPool();
        d.pool = { masterPool, assetVersion: asset.version };
    });
}
