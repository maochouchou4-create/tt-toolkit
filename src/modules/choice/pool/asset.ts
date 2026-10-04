/**
 * 内置池资产（批C.2 只读化）：default-pool.json 是条目池的唯一真相源，
 * 内容随插件仓库发布（编辑走 git 更新链，用户在 UI 里只读浏览）。
 *
 * 同步策略：启动时（initChoice / initChoiceMinimal）以 asset 覆盖存储里的
 * 内容域——masterPool/poolConfigs 全量重建；用户域只剩运行时开关（gen 的
 * autoGenerate/categoriesEnabled 等），syncAssetPool 不碰（唯一例外见
 * 首次同步注释）。assetVersion 标记使重复启动零写入（幂等快路径）。
 */
import assetJson from './default-pool.json';
import type { PoolConfig, PoolEntry } from './types';
import type { PoolDomainData } from './normalize';
import { safeWeight } from './resolver';
import { choiceStorage } from '../api';

/** asset 池配置的固定 id（确定性，跨版本不变；chat 绑定悬空时回退默认恒命中）。 */
export const ASSET_POOL_CONFIG_ID = 'asset-default';

/** default-pool.json 的静态形状（构建产物，自身可信；normalize 只为防御）。 */
interface PoolAsset {
    version: number;
    rules: string;
    entries: Array<{
        type: string;
        content: string;
        rule?: string;
        category: string;
        pinned?: boolean;
        weight?: number;
    }>;
}

const asset = assetJson as unknown as PoolAsset;

/**
 * asset → 运行时池形状的确定性映射：条目 id=asset-<序号>（顺序即 json 顺序，
 * 不掺时间/随机——同一份 json 永远映射出同一池，幂等重写不产生 diff 噪声）。
 */
export function buildAssetPool(): Pick<PoolDomainData, 'masterPool' | 'poolConfigs'> & { rules: string } {
    const masterPool: PoolEntry[] = asset.entries.map((e, i) => ({
        id: `asset-${i + 1}`,
        type: e.type,
        content: e.content,
        rule: e.rule ?? '',
        category: e.category,
        pinned: e.pinned ?? false,
        weight: safeWeight(e.weight),
    }));
    const poolConfigs: PoolConfig[] = [{
        id: ASSET_POOL_CONFIG_ID,
        name: '默认配置',
        isDefault: true,
        rules: asset.rules,
        // 引用层全量镜像（enabled 恒 true，pinned/weight 镜像条目——只读化后
        // 引用层不再承担「挑选子集」职责，保留结构是为 resolver 管线零改动）
        entries: masterPool.map(e => ({ entryId: e.id, enabled: true, pinned: e.pinned, weight: e.weight })),
    }];
    return { masterPool, poolConfigs, rules: asset.rules };
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
        const { masterPool, poolConfigs } = buildAssetPool();
        d.pool = { masterPool, poolConfigs, assetVersion: asset.version };
        if (firstSync && !d.gen.categoriesEnabled) {
            d.gen.categoriesEnabled = true;
        }
    });
}
