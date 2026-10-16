/**
 * 档案叶值的**确定性**判定（纯函数层：无 IO、不读宿主、不碰存储）：叶值归一
 * 与完全同值分组（literal）、目录对照体检。
 *
 * 诚实边界（读这份代码之前先读这段，它决定本模块能被当成什么用）：
 * 本模块只判定**归一后完全同值**这一类确定性问题（literal）。它**不判定语义
 * 重复**：同一个母题被三个叶各写一遍同义改写（「妹妹只有他」写成三种说法），
 * 在本模块眼里是三条互不相等的值，检出率为零。这不是待补的短板，是本层的
 * 既定边界——文本层的字面比对原理上抓不到同义改写，而收窄判据去「像一点」的
 * 匹配只会在命中即直改的链路上制造误改。语义重复清不清得干净，完全取决于
 * 那一次模型复核：模型漏就是漏，本模块不兜、也不假装兜。
 *
 * 因此接线侧不设「本模块判无重复就跳过复核」的门槛——拿一个语义检出率为零的
 * 判定当闸门，它的漏检会原样还给用户。本模块的产出无条件随每份档案一起跑，
 * 由复核那一轮兜它盖不住的面。
 *
 * 导入纪律：目录与档案占位符各自从叶子文件取（`@/modules/persona/catalog`、
 * `@/prompts/defaults`），解析层从同目录的叶子文件取（`./yaml`）。三者都
 * 不经任何 barrel 取——barrel 会 re-export 冒烟与生成链，经它取会把整条链
 * 拉进消费方的初始化链并形成环状导入。
 */
import { catalogKeySet, type CatalogBlock } from '@/modules/persona/catalog';
import { PROFILE_PLACEHOLDER_VALUES } from '@/prompts/defaults';
import { scanProfileLeaves, type ProfileLeafRow, type ProfileScan } from './yaml';

/** 一条 literal 命中：block·leaf 是该组的锚点（档案里第一次落这事实的那一叶），group 是全部同值叶。 */
interface LiteralHit {
    block: string;
    leaf: string;
    group: ReadonlyArray<{ block: string; leaf: string }>;
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
 * 完全同值分组的可比签名（组内叶键排序后以 | 连接）。
 *
 * 消费方是复核轮改完之后的「无新增完全同值」校验：改写的目的是拆开原有的同值
 * 组，**新增**才是事故——两者靠分组签名区分（只看「改后还有几组」会把拆开也
 * 判成新增，因为组数变了）。
 *
 * 它不抛错：校验侧要的是「扫到了什么」，能不能拿这个结论由调用方的形状闸决定。
 */
export function literalDuplicateSignatures(yamlText: string): ReadonlyArray<string> {
    return literalHits(scanProfileLeaves(yamlText).leaves).map(hit =>
        hit.group.map(leaf => `${leaf.block}·${leaf.leaf}`).sort().join('|'));
}

/**
 * 叶键是否在目录里：精确命中，或落在某个模板叶块的「块名·」前缀哨兵下
 * （哨兵契约见 catalog.ts 的 catalogKeySet）。
 */
function isRecognizedLeafKey(keys: ReadonlySet<string>, openEndedPrefixes: ReadonlyArray<string>, key: string): boolean {
    if (keys.has(key)) return true;
    return openEndedPrefixes.some(prefix => key.startsWith(prefix));
}

/**
 * 目录漂移体检的窄出口（一段档案文本 → 三个计数）。
 *
 * **永不抛**：它是挂在生成链收尾的体检告警，诊断不参与成败——让一个「这不是
 * 一份档案」的输入把告警变成错误，等于让体检在最需要说话的时候闭嘴。窄在这里
 * 指只算漂移相关的账（目录对照），不算完全同值（literal 与目录无关，算它纯属
 * 浪费）。
 */
export interface CatalogDriftReport {
    /** 要查的那一类：目录里存在的块下，模型写出了目录没有的叶。 */
    catalogDriftLeaves: ReadonlyArray<string>;
    /** 整块在目录外的块数（机制挂载块——正常形态，只作上下文）。 */
    mechanismBlocksOutsideCatalog: number;
    /** 未识别叶与无主行合计（含机制挂载块的叶，同样只作上下文）。 */
    unrecognizedLeavesTotal: number;
}

/** 目录对照的内部产物（窄出口的计数直接由它派生，不复制逻辑）。 */
interface CatalogDriftScan {
    unrecognizedBlocks: ReadonlyArray<string>;
    unrecognizedLeaves: ReadonlyArray<string>;
    catalogDriftLeaves: ReadonlyArray<string>;
    orphanLineCount: number;
}

/**
 * 目录对照扫描（私有；不抛错）。
 *
 * 「要查的那一类」＝未识别叶里、其所在块在目录内的那些：机制挂载块整块在目录外是
 * 正常形态（`unrecognizedBlocks` 那条注释写明「永远不必补叶」），把它算进来等于
 * 每份挂机制块的正常档案都喊一次漂移。
 */
function scanCatalogDrift(scan: ProfileScan, knownKeysCatalog?: ReadonlyArray<CatalogBlock>): CatalogDriftScan {
    const keys = catalogKeySet(knownKeysCatalog);
    const openEndedPrefixes = [...keys].filter(key => key.endsWith('·'));
    const unrecognizedBlocks = scan.blockKeys.filter(block => !keys.has(block));
    const unrecognizedLeaves = scan.leafKeys.filter(key => !isRecognizedLeafKey(keys, openEndedPrefixes, key));
    const inCatalogBlocks = new Set(scan.blockKeys.filter(block => keys.has(block)));
    return {
        unrecognizedBlocks,
        unrecognizedLeaves,
        catalogDriftLeaves: unrecognizedLeaves.filter(key => inCatalogBlocks.has(key.slice(0, key.indexOf('·')))),
        orphanLineCount: scan.orphanLines.length,
    };
}

/** 目录漂移体检（窄入口，永不抛）。 */
export function analyzeCatalogDrift(yamlText: string, knownKeysCatalog?: ReadonlyArray<CatalogBlock>): CatalogDriftReport {
    const drift = scanCatalogDrift(scanProfileLeaves(yamlText), knownKeysCatalog);
    return {
        catalogDriftLeaves: drift.catalogDriftLeaves,
        mechanismBlocksOutsideCatalog: drift.unrecognizedBlocks.length,
        unrecognizedLeavesTotal: drift.unrecognizedLeaves.length + drift.orphanLineCount,
    };
}
