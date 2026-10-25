/**
 * 复核回合的结论落地（纯逻辑层：无 IO、不发请求、不碰存储、不管文案）。
 *
 * 一件事：**把模型那一轮的回复落成档案**。回执与指令是同一份契约的两态：
 * 「无重复」四字，或改好后的整份档案（yaml 围栏）。整档回执**不直接采用**——
 * 直接采用等于把档案定稿权交给模型输出的稳定性——而是走「剥围栏 → 扫描 →
 * 骨架对账 → 逐叶合并守卫 → 改后校验」，任一步不过就抛 `ReviewUnusableError`
 * ——**只有这一种异常类型出这道门**，调用方据此回滚到首轮档案并降级提示。
 * 守卫保住的是审计性：哪几叶真变了由归一比对说了算（归一同值的皮毛漂移还原成
 * 原文行，模型对未涉重叶的非实质改动一律不落档），简报只点名真变叶；本模块
 * 不做「尽力而为的部分套用」——骨架对不上就整轮作废，半套用的档案比不套用
 * 更坏（用户看不出哪几叶被模型动过，却拿到一份既不是模型那版也不是自己那版
 * 的档案）。
 *
 * 边界（与判据层同一条纪律）：这里只做苦力——剥围栏、扫描、骨架对账、逐叶
 * 合并、校验、出简报**数据**。**不判语义、不做触发器、不删东西**：哪两叶在
 * 说同一件事、改成什么，由模型说；合并只决定模型给的值收不收、以哪种形态收。
 * 文案不在本文件（同一 tab 的文案唯一真源是 strings.ts 的 TEXT.REVIEW_BRIEF），
 * 本文件只出态。
 */
import { stripYamlFence } from './generation-wrap';
import { isSameLeafValue, literalDuplicateSignatures } from './redundancy';
import { TEXT } from './strings';
import { scanProfileLeaves, shapeOfScan, splitProfileLines } from './yaml';

/**
 * 返回契约在代码里的字面量（判据与指令同源，不各写一份）。
 */
const NO_DUPLICATE_ANSWER = '无重复';
/** 档案内的真分隔符（块·叶）：changedKeys 与简报展示统一这一形态。 */
const KEY_SEPARATOR = '·';

/** 复核失败的原因（值域即文案白名单恰三项，模型原始报错进不来）。 */
export type ReviewFailureReason = (typeof TEXT.REVIEW_BRIEF.FAILURE_REASON)[keyof typeof TEXT.REVIEW_BRIEF.FAILURE_REASON];

/**
 * 复核简报四态（UI 消费面；渲染在 store getter，文案在 strings.ts）。
 *
 * **它绝不并进档案正文**：档案经 `upsertPersona` 写进宿主 `persona_description`、
 * 经 `inject_persona` 进入此后每一轮对话，一行 UI 文案混进去就是每轮都在
 * 提示词里漂着「模型复核：…」。它也**不落 persona 域**（域归一按字段重建，
 * 没登记的字段存不进去，硬塞只会得到一个每轮都被抹掉的影子）。
 *
 * - `notRun` 是必做态：结果框为空（本会话还没生成过／清空后）时它是唯一诚实的
 *   说法。少这一态，用户在「未发现重复」与「没跑过」之间无法分辨。
 */
export type ReviewBrief =
    | { kind: 'rewritten'; changedKeys: ReadonlyArray<string> }
    | { kind: 'none' }
    | { kind: 'failed'; reason: ReviewFailureReason }
    | { kind: 'notRun' };

/** 未跑过（结果框为空／清空后）的简报态——出厂即这一态。 */
export const REVIEW_BRIEF_NOT_RUN: ReviewBrief = { kind: 'notRun' };

/** 简报渲染：四态逐字取自 strings.ts。n＝归一比对后真变的叶数，未涉重叶不进。 */
export function renderReviewBrief(brief: ReviewBrief): string {
    switch (brief.kind) {
        case 'rewritten':
            return TEXT.REVIEW_BRIEF.REWRITTEN(brief.changedKeys.length, brief.changedKeys.join('、'));
        case 'none':
            return TEXT.REVIEW_BRIEF.NONE;
        case 'failed':
            return TEXT.REVIEW_BRIEF.FAILED(brief.reason);
        case 'notRun':
            return TEXT.REVIEW_BRIEF.NOT_RUN;
    }
}

/** 复核结果不可用：解析不到、套不成、或改后校验不过。调用方据此回滚。 */
export class ReviewUnusableError extends Error {
    constructor(detail: string) {
        super(`复核结果不可用：${detail}`);
        this.name = 'ReviewUnusableError';
    }
}

/** 复核结论的落地结果：`none`＝模型说无重复；`rewritten`＝带改写后的档案。 */
export type ReviewOutcome =
    | { kind: 'none' }
    | { kind: 'rewritten'; text: string; changedKeys: ReadonlyArray<string> };

/** 一处待套用的叶级改动：把原档 [lineStart, lineEnd] 行区间换成 replacementRows。 */
interface PendingEdit {
    lineStart: number;
    lineEnd: number;
    replacementRows: string[];
}

/** 行首空白宽度（缩进口径的唯一现算点：ProfileLeafRow 不带缩进字段）。 */
const indentOf = (line: string): number => line.search(/\S|$/);

/**
 * 把模型的复核回复落成档案。
 *
 * 逐条对着返回契约走（两态机判分明）：
 *   - 整段 `trim()` 后等于 `无重复` ⇒ 无需改写（**逐字相等**：模型多写一句
 *     说明就当不可用——宽松匹配等于让「无重复，但其实是散文」混过去，而
 *     用户看不到模型到底说了什么）；
 *   - 否则剥围栏（无围栏宽松放行：完整 YAML 直接走通，非档案文本由下一步
 *     扫描兜底），`scanProfileLeaves` 扫模型输出——解不出块或零叶即不可用，
 *     **不启发式猜**；
 *   - **骨架校验（真正的防错面）**：模型输出的块清单与叶清单（含顺序）与
 *     原档逐项相等，不等即不可用——改写轮不得动策展结果，删叶/加叶/改名/
 *     调序都在这里出局。旧按行契约里「点名的叶不在档案里」的防错面由它
 *     承接，且防得更宽：整个结构漂移面一次拦下；
 *   - **逐叶合并（守卫核心）**：叶键清单相等 ⇒ 两条扫描的叶序列**按扫描
 *     顺序索引对齐**（第 i 个对第 i 个；刻意不按键名分桶——按名合并会在
 *     同名叶出现多次时把两处一起换掉）。逐叶归一比对：同值 ⇒ **逐字保留
 *     原文行**（模型动了标点/全半角/空白等皮毛也还原回去）；不同 ⇒ 取模型
 *     值——两侧都是单行标量叶沿用行内 splice（原行键前缀逐字保留），多行/
 *     列表叶移植模型该叶的行区间，缩进按「原档键行缩进 − 模型键行缩进」
 *     差值整体平移（保留模型内部相对结构、键行落回原档列位）。orphan 行与
 *     顶格散文不在骨架校验面：模型对这类行的改动静默丢弃、以原档为准——
 *     这类行本就不该由复核轮改（代价是模型意图不落地且不进简报，接受）；
 *   - 零变化拒绝：合并后变更叶数为 0 ⇒ 不可用（模型没回「无重复」却什么
 *     都没改——照单全收会让简报谎报「已改写」而档案逐字未变）；
 *   - 改后校验：无新增完全同值组（literalDuplicateSignatures，脚本侧唯一有
 *     把握的那条判据）；骨架相等重扫合并文**恒真**（合并以原档为底、键前缀
 *     逐字保留），保留为合并算法的自检断言——**检出力在上面的骨架校验**，
 *     这道只防 splice/缩进平移的实现回归。形状不可判定时同值校验缺席
 *     （缺席由调用方在复核入口打日志）。
 */
export function applyReviewVerdict(profileText: string, reply: string): ReviewOutcome {
    if (reply.trim() === NO_DUPLICATE_ANSWER) return { kind: 'none' };

    const before = scanProfileLeaves(profileText);
    const lines = splitProfileLines(profileText);
    // 围栏剥离宽松放行（stripYamlFence 无围栏时返回原文）；prefill 传空串——
    // 复核轮没有起手词，「补回起手词」那支判据对它无意义。**只从
    // './generation-wrap' 取**：generation.ts 的 re-export 会把整条生成链拉进
    // 本模块的初始化链并成环。
    const replyText = stripYamlFence(reply, '');
    const modelScan = scanProfileLeaves(replyText);
    const modelLines = splitProfileLines(replyText);
    if (modelScan.blockKeys.length === 0 || modelScan.leaves.length === 0) {
        throw new ReviewUnusableError('回执扫不出任何块或叶——不是一份可用的档案');
    }
    // 骨架校验：改写轮不得动策展结果（含顺序比对——顺序变了意味着整份档案
    // 的结构已被重排，逐叶索引对齐随之失去前提）。
    if (modelScan.blockKeys.join('\n') !== before.blockKeys.join('\n')) {
        throw new ReviewUnusableError('回执的顶层块清单与档案不一致（增删了块或改了块名/顺序）');
    }
    if (modelScan.leafKeys.join('\n') !== before.leafKeys.join('\n')) {
        throw new ReviewUnusableError('回执的叶清单与档案不一致（增删了叶或改了叶名/顺序）');
    }

    const changedKeys: string[] = [];
    const edits: PendingEdit[] = [];
    for (let i = 0; i < before.leaves.length; i++) {
        const orig = before.leaves[i];
        const model = modelScan.leaves[i];
        if (isSameLeafValue(orig.value, model.value)) continue;
        // 整档抄写的漏值形态：模型把有值叶抄成空值（`键:`）不是改写而是丢内容
        // ——放行即静默清空原档，且零变化与同值组两道校验都拦不住它。整轮拒绝
        // 回滚、不做任何部分套用（与骨架漂移同一纪律），整档抄写漏值不得清空原档。
        if (model.value.trim() === '') throw new ReviewUnusableError(`回执把有值叶改成了空值：${orig.block}${KEY_SEPARATOR}${orig.leaf}`);
        changedKeys.push(`${orig.block}${KEY_SEPARATOR}${orig.leaf}`);
        if (orig.lineStart === orig.lineEnd && model.lineStart === model.lineEnd
            && orig.form === 'scalar' && model.form === 'scalar') {
            // 单行标量叶：原行键前缀（缩进、叶名、冒号与其后的空白）逐字保留，
            // 行内换值。原档该行值段为空（`键:` 形态）时前缀止于冒号，补一个
            // 空格把「键: 值」的既有形态续上。
            const prefix = lines[orig.lineStart].slice(0, orig.valueStart);
            const joiner = prefix.endsWith(':') || prefix.endsWith('：') ? ' ' : '';
            edits.push({ lineStart: orig.lineStart, lineEnd: orig.lineEnd, replacementRows: [`${prefix}${joiner}${model.value}`] });
            continue;
        }
        // 多行/列表叶：移植模型该叶的行区间。键行＝原键前缀＋模型值段（原值段
        // 为空时同上补空格），续行缩进按差值整体平移、钳在 0——模型内部相对
        // 结构原样保留，键行落回原档列位。
        const shift = indentOf(lines[orig.lineStart]) - indentOf(modelLines[model.lineStart]);
        const keyPrefix = lines[orig.lineStart].slice(0, orig.valueStart);
        const valueHead = modelLines[model.lineStart].slice(model.valueStart);
        const joiner = valueHead === '' ? '' : (keyPrefix.endsWith(':') || keyPrefix.endsWith('：') ? ' ' : '');
        const replacementRows = modelLines.slice(model.lineStart, model.lineEnd + 1).map((row, index) => {
            if (index === 0) return `${keyPrefix}${joiner}${valueHead}`;
            return ' '.repeat(Math.max(0, indentOf(row) + shift)) + row.slice(indentOf(row));
        });
        edits.push({ lineStart: orig.lineStart, lineEnd: orig.lineEnd, replacementRows });
    }
    if (changedKeys.length === 0) {
        throw new ReviewUnusableError('模型没有回「无重复」，逐叶比对却没有任何叶被改动');
    }

    const out = [...lines];
    // 自后向前套用：前面的行号不因后续行数增减而位移（一次 splice 换掉一叶
    // 的整段行区间，顺序反了就会删错行）。
    for (const edit of [...edits].reverse()) {
        out.splice(edit.lineStart, edit.lineEnd - edit.lineStart + 1, ...edit.replacementRows);
    }
    const text = out.join('\n');

    // 改后校验第一道（合并算法自检）：合并以原档为底、键前缀逐字保留，重扫
    // 骨架必等——对合并文恒真。真正检出力在上面对模型输出的骨架校验，这道
    // 只防 splice/缩进平移的实现回归。
    const after = scanProfileLeaves(text);
    if (after.blockKeys.join('\n') !== before.blockKeys.join('\n')) {
        throw new ReviewUnusableError('合并后顶层块清单变了（合并算法自检失败）');
    }
    if (after.leafKeys.join('\n') !== before.leafKeys.join('\n')) {
        throw new ReviewUnusableError('合并后叶清单变了（合并算法自检失败）');
    }
    // 改后校验第二道：无新增完全同值组（原有的重复被拆开是这次改写的目的，
    // 新增才是事故）。形状由**这份档案自己**的扫描派生——「形状说的就是这份
    // 文本」得是结构上的事实，交给调用方送一份可能来自别的文本的形状进来，
    // 校验就会读着一份不相干的形状放行或翻红。形状不可判定时这道缺席：模型
    // 照样复核、结论照样落地，只是依赖完整叶集的那道校验本轮不在场（缺席由
    // 调用方在复核入口打日志）。
    if (shapeOfScan(before).ok) {
        const groupsBefore = new Set(literalDuplicateSignatures(profileText));
        for (const signature of literalDuplicateSignatures(text)) {
            if (!groupsBefore.has(signature)) {
                throw new ReviewUnusableError(`改写新增了完全同值的叶组：${signature.split('|').join('、')}`);
            }
        }
    }

    return { kind: 'rewritten', text, changedKeys };
}
