/**
 * 档案里「同一类事实被两个叶各写一遍」的**确定性**判定（纯函数层：无 IO、
 * 不读宿主、不碰存储）。
 *
 * 诚实边界（读这份代码之前先读这段，它决定本模块能被当成什么用）：
 * 本模块只判定两类确定性重复——归一后**完全同值**（literal）与**归属优先级表
 * 两端同时在场**（structural）。它**不判定语义重复**：同一个母题被三个叶各写
 * 一遍同义改写（「妹妹只有他」写成三种说法），在本模块眼里是三条互不相等的
 * 值，检出率为零。这不是待补的短板，是本层的既定边界——文本层的字面比对原理
 * 上抓不到同义改写，而收窄判据去「像一点」的匹配只会在命中即直改的链路上制造
 * 误改。语义重复清不清得干净，完全取决于那一次模型复核：模型漏就是漏，本模块
 * 不兜、也不假装兜。
 *
 * 因此接线侧不设「本模块判无重复就跳过复核」的门槛——拿一个语义检出率为零的
 * 判定当闸门，它的漏检会原样还给用户。本模块的产出无条件随每份档案一起跑，
 * 由复核那一轮兜它盖不住的面。
 *
 * 导入纪律：目录与生成契约都只从叶子文件取（`@/prompts/catalog`、
 * `@/prompts/defaults`），解析层从同目录的叶子文件取（`./yaml`）。经任何
 * barrel 取会把冒烟与生成链拖进同一条初始化链，在模块初始化期求值模板字面量
 * （TDZ），并让本文件在别的任务上也被执行。
 */
import { OWNERSHIP_PAIRS, catalogKeySet, type CatalogBlock } from '@/prompts/catalog';
import { PROFILE_PLACEHOLDER_VALUES } from '@/prompts/defaults';
import { ProfileUndecidableError, scanProfileLeaves, shapeOfScan, type ProfileLeafRow, type ProfileUndecidableCode } from './yaml';

/**
 * 分类码与异常在本层的对外门面（定义在解析层 yaml.ts，理由见那边：解析层是
 * 下层，形态码住在下层才不会与消费层形成环状依赖）。消费方从本文件取即可，
 * 不必知道异常类住在哪一层。
 */
export { ProfileUndecidableError };
export type { ProfileUndecidableCode };

/** 一条 literal 命中：block·leaf 是该组的锚点（档案里第一次落这事实的那一叶），group 是全部同值叶。 */
export interface LiteralHit {
    block: string;
    leaf: string;
    group: ReadonlyArray<{ block: string; leaf: string }>;
}

export interface RedundancyReport {
    literal: ReadonlyArray<LiteralHit>;
    structural: ReadonlyArray<readonly [string, string]>;
    /**
     * 整块在目录外的块名（机制挂载块按该世界的原生词汇命名，本来就不该在目录
     * 里——**永远不必补叶**）。
     *
     * 它与 unrecognizedLeaves 是两回事，合成一个计数就把两类处置混掉了：这一类
     * 是「模型按该世界的原生词汇挂了一块机制」，那一类是「目录里这块有、模型多
     * 写了一叶」，后者要查。
     */
    unrecognizedBlocks: ReadonlyArray<string>;
    /**
     * 未识别的叶（`块·叶`）与无主行（裸列表项、无叶可并的缩进散文，原样行）。
     *
     * 它是**目录漂移的体检信号，不是语义判据**，不参与任何自动处置（不改写、
     * 不拦截、不进简报的重复结论）；「目录是不是该补叶」是人的事。
     */
    unrecognizedLeaves: ReadonlyArray<string>;
}

/**
 * 归一的两段分工（写死；本模块只有这一份实现，`literal` 判定与改后校验的
 * 「无新增完全同值」都走它）：
 *   1. **NFKC**：全角拉丁字母与数字、各类兼容字形折成等义半角形，**并且已经把
 *      全角标点折成半角**（`，、：；？！（）` 与全角空格都在这一段里完成）；
 *   2. **PUNCTUATION_FOLD**：只补 NFKC 不碰的那几个（见表下注释）；
 *   3. 连续空白（含换行、全角空格）折叠成一个半角空格；
 *   4. 去首尾空白。
 *
 * 表里**不许留 NFKC 已覆盖的条目**：那些条目永远走不到，留着会让人以为这张表是
 * 完备的——将来动了 NFKC（或换实现）时测试仍绿而行为已变。反过来，表里真生效的
 * 字符各有一条「只有它能成立」的断言（冒烟「标点表真生效字符」那条）。
 *
 * **刻意不折叠大小写**：专名与缩写的大小写带信息（`MBTI`／`Dr. Smith`），折
 * 起来会把两个不同的写法判成同一个事实，而本判据一旦命中就驱动直改。
 */
const PUNCTUATION_FOLD: Readonly<Record<string, string>> = {
    // 下列每一个 NFKC 都不碰，且各有「只有它能成立」的断言兜着：
    '。': '.',
    '、': ',',
    '【': '[',
    '】': ']',
    '《': '<',
    '》': '>',
    '“': '"',
    '”': '"',
    '‘': "'",
    '’': "'",
    '—': '-',
};

const PUNCTUATION_RE = new RegExp(`[${Object.keys(PUNCTUATION_FOLD).join('')}]`, 'g');

/** 叶值归一（本模块唯一的「同值」口径）。 */
export function normalizeLeafValue(raw: string): string {
    return raw
        .normalize('NFKC')
        .replace(PUNCTUATION_RE, ch => PUNCTUATION_FOLD[ch])
        .replace(/\s+/g, ' ')
        .trim();
}

/** 两个叶值归一后是否完全同值（literal 判定与改后校验共用的判据出口）。 */
export function isSameLeafValue(a: string, b: string): boolean {
    return normalizeLeafValue(a) === normalizeLeafValue(b);
}

/**
 * 「没有内容」的唯一判据点：这一叶的值算不算真写了内容。
 *
 * 四类同源形态都在这里排除，缺一类就多一类假命中：
 *   - 空串（归一后为空）；
 *   - 列表承载形态（值由 '- ' 项承载，不由单个字符串承载，「同值」无从谈起）；
 *   - 生成契约要求 5 点名的偷懒占位（词表取自 defaults.ts 的
 *     PROFILE_PLACEHOLDER_VALUES，本模块不另抄）；
 *   - 裸 `-`（契约同句禁掉的列表记号，模型手滑时会写成 `年龄: -`）。
 *
 * **为什么必须先排除**：被排除的叶取到的都是同一个「没有内容」，M 个这样的叶
 * 两两互判「完全同值」即 M²/2 对命中，而它们承载的事实是「这里空着」——计数一旦
 * 点着自动改写，就是对着留白的档案批量覆写。
 *
 * 刻意**不**排除要求 6 允许的叙事占位（「尚未发生（角色现年24岁，未达此阶段）」）：
 * 那类值带原因、有内容，与偷懒占位不是一回事。
 */
export function isJudgeableLeaf(row: ProfileLeafRow): boolean {
    if (row.form === 'list') return false;
    const value = normalizeLeafValue(row.value);
    if (value === '' || value === '-') return false;
    return !PROFILE_PLACEHOLDER_VALUES.includes(value);
}

/**
 * 完全同值分组（按档案中首次出现的顺序输出，锚点＝组内首叶）。
 *
 * 组内按「块·叶」去重：同一个键写了两遍是重复键，不是「一件事写进两个叶」，
 * 混进来会让直改改成自己。
 */
function literalHits(leaves: ReadonlyArray<ProfileLeafRow>): ReadonlyArray<LiteralHit> {
    const byValue = new Map<string, ProfileLeafRow[]>();
    for (const leaf of leaves) {
        if (!isJudgeableLeaf(leaf)) continue;
        const value = normalizeLeafValue(leaf.value);
        const bucket = byValue.get(value);
        if (bucket) bucket.push(leaf);
        else byValue.set(value, [leaf]);
    }
    const hits: LiteralHit[] = [];
    for (const bucket of byValue.values()) {
        const seen = new Set<string>();
        const group: Array<{ block: string; leaf: string }> = [];
        for (const leaf of bucket) {
            const key = `${leaf.block}·${leaf.leaf}`;
            if (seen.has(key)) continue;
            seen.add(key);
            group.push({ block: leaf.block, leaf: leaf.leaf });
        }
        if (group.length < 2) continue;
        hits.push({ block: group[0].block, leaf: group[0].leaf, group });
    }
    return hits;
}

/**
 * 结构冲突：归属优先级表两端同时在场（按「块·叶」比对，数据源是 catalog 的
 * OWNERSHIP_PAIRS —— 与提示词里那张表共用一份，此处不另抄）。
 *
 * 输出是**候选**不是判决：同块共存的两对（底线雷区·绝不做之事 × 行为禁区、
 * 目标动机·外部义务 × 深层需要）报出来是常态，它们的两端确实该同时在场——
 * 该不该判成重复由接模型复核的那一轮定。
 *
 * 与目录参数无关：归属优先级表是模块级事实，传进来的目录只管未识别计数与
 * 「目录外叶过半」的降级判定。
 */
function structuralHits(leaves: ReadonlyArray<ProfileLeafRow>): ReadonlyArray<readonly [string, string]> {
    const present = new Set(leaves.map(leaf => `${leaf.block}·${leaf.leaf}`));
    return OWNERSHIP_PAIRS.filter(([owner, other]) => present.has(owner) && present.has(other));
}

/**
 * 叶键是否在目录里：精确命中，或落在某个模板叶块的「块名·」前缀哨兵下
 * （哨兵契约见 catalog.ts 的 catalogKeySet）。
 */
function isRecognizedLeafKey(keys: ReadonlySet<string>, openEndedPrefixes: ReadonlyArray<string>, key: string): boolean {
    if (keys.has(key)) return true;
    return openEndedPrefixes.some(prefix => key.startsWith(prefix));
}

/** 目录外叶过半的判定线（见 analyzeRedundancy 处的取舍说明）。 */
const MOSTLY_OUT_OF_CATALOG_RATIO = 0.5;

/**
 * 判据入口：一份填好的档案文本 → 确定性重复报告。
 *
 * 参数 `knownKeysCatalog` 的作用域只有两处：未识别块／未识别叶两个计数，以及
 * 「目录外叶过半」的降级判定。`structural` 走模块级 OWNERSHIP_PAIRS，不看它。
 *
 * 不可判定的输入抛 ProfileUndecidableError（带 code 与计数），不返回空报告——
 * 空报告与「档案里没有重复」同形，把不可判定说成「没有」是本层最危险的谎。
 */
export function analyzeRedundancy(yamlText: string, knownKeysCatalog?: ReadonlyArray<CatalogBlock>): RedundancyReport {
    const scan = scanProfileLeaves(yamlText);
    const shape = shapeOfScan(scan);
    if (!shape.ok) throw new ProfileUndecidableError(shape.code ?? 'EMPTY', shape.topLevelBlocks, shape.leafCount);
    const keys = catalogKeySet(knownKeysCatalog);
    const openEndedPrefixes = [...keys].filter(key => key.endsWith('·'));

    const unrecognizedBlocks = scan.blockKeys.filter(block => !keys.has(block));
    const unrecognizedLeaves = scan.leafKeys.filter(key => !isRecognizedLeafKey(keys, openEndedPrefixes, key));
    const inCatalogBlocks = new Set(scan.blockKeys.filter(block => keys.has(block)));

    // 「这份文本是不是档案」的降级判定。目录是「什么算档案叶」的唯一权威，而
    // 形状闸只看得见块数与叶数——宿主错误正文（`连接失败: 请求超时: 请重试`
    // 这类双冒号散文）凑够两个顶层块就能混过去，以一份档案的身份报「未发现重复」。
    //
    // 判定线取「目录外叶过半」，而分子只数**目录内的块里写出的目录外叶**：机制
    // 挂载块整块在目录外是正常形态（unrecognizedBlocks 那条注释写明「永远不必补
    // 叶」），把它算进分子就会把机制挂得多的正常档案判成不是档案。块整块都在
    // 目录外、而档案里一个目录内的块都没有，另走一条——那是外来文本，同样不可判定。
    const driftLeaves = unrecognizedLeaves.filter(key => inCatalogBlocks.has(key.slice(0, key.indexOf('·'))));
    const leafCount = scan.leaves.length;
    if (leafCount > 0 && (driftLeaves.length > leafCount * MOSTLY_OUT_OF_CATALOG_RATIO || inCatalogBlocks.size === 0)) {
        throw new ProfileUndecidableError('MOSTLY_OUT_OF_CATALOG', scan.blocks.length, leafCount);
    }

    return {
        literal: literalHits(scan.leaves),
        structural: structuralHits(scan.leaves),
        unrecognizedBlocks,
        unrecognizedLeaves: [...unrecognizedLeaves, ...scan.orphanLines],
    };
}
