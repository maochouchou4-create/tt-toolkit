/**
 * 复核回合的结论落地（纯逻辑层：无 IO、不发请求、不碰存储、不管文案）。
 *
 * 一件事：**把模型那一轮的回复落成档案**。链路形态是
 * 「解析 → 按「块·叶」精确套用 → 改后校验」，三步里任一步不过就抛
 * `ReviewUnusableError`——**只有这一种异常类型出这道门**，调用方据此回滚到首轮
 * 档案并降级提示。本模块不做「尽力而为的部分套用」：半套用的档案比不套用更坏
 * （用户看不出哪几叶被模型动过，却拿到一份既不是模型那版也不是自己那版的档案）。
 *
 * 边界（与判据层同一条纪律）：这里只做四件苦力——定位、精确替换、校验、出
 * 简报**数据**。**不判语义、不做触发器、不删东西**：哪两叶在说同一件事由模型说，
 * 脚本对「像」没有判据；被点名的叶一律按模型给的值整叶替换，脚本不删不改它
 * 的内容形状。文案不在本文件（同一 tab 的文案唯一真源是 strings.ts 的
 * TEXT.REVIEW_BRIEF），本文件只出态。
 */
import { isSameLeafValue, literalDuplicateSignatures } from './redundancy';
import { TEXT } from './strings';
import { scanProfileLeaves, shapeOfScan, splitProfileLines, type ProfileLeafRow } from './yaml';

/**
 * 返回契约在代码里的四个字面量（判据与指令同源，不各写一份）。
 *
 * 行首切分符取**第一个**「 → 」（箭头左右各一个半角空格）：新值里可以含箭头
 * （「值 → 值」本身是个合法的句子），按第一个切才与指令的承诺一致。
 */
const NO_DUPLICATE_ANSWER = '无重复';
const KEEP_AS_IS = '保留';
const VERDICT_ARROW = ' → ';
/** 档案内的真分隔符（块·叶）。 */
const KEY_SEPARATOR = '·';
/**
 * 模型点名的叶名分隔符（指令样例里的形态：块.叶）。
 *
 * 模型照着指令抄，多半回的是这个形态，而档案里的一律是 `·`。解析端两种都收
 * （`.split('.')` 对已是 `·` 的键名是恒等变换），简报端按同一形态出 `.`——
 * 用户看到的叶名与模型回执里那一份逐字一致，两边对得上。
 */
const MODEL_KEY_SEPARATOR = '.';

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

/** 简报渲染：四态逐字取自 strings.ts。n 一律指被改写的叶数，不含被保留的叶。 */
export function renderReviewBrief(brief: ReviewBrief): string {
    switch (brief.kind) {
        case 'rewritten':
            return TEXT.REVIEW_BRIEF.REWRITTEN(brief.changedKeys.length, brief.changedKeys.map(displayKey).join('、'));
        case 'none':
            return TEXT.REVIEW_BRIEF.NONE;
        case 'failed':
            return TEXT.REVIEW_BRIEF.FAILED(brief.reason);
        case 'notRun':
            return TEXT.REVIEW_BRIEF.NOT_RUN;
    }
}

/** 叶键的展示形态（与模型回执里的点名形态逐字一致：块.叶）。 */
function displayKey(key: string): string {
    return key.split(KEY_SEPARATOR).join(MODEL_KEY_SEPARATOR);
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

/** 一条可执行的改写：定位行（按名解析得到）＋新值。 */
interface PendingRewrite {
    key: string;
    rows: ReadonlyArray<ProfileLeafRow>;
    value: string;
}

/**
 * 把模型的复核回复落成档案。
 *
 * 逐条对着返回契约走：
 *   - 整段 `trim()` 后等于 `无重复` ⇒ 无需改写（**逐字相等**：模型多写一句
 *     说明就当不可用——宽松匹配等于让「无重复，但其实是散文」混过去，而
 *     用户看不到模型到底说了什么）；
 *   - 否则逐行按第一个「 → 」切成「叶名」与「新值」；叶名必须命中档案里真实
 *     存在的叶，否则抛错（**不按目录判**：机制挂载块按该世界的原生词汇命名，
 *     它的叶整块在目录外，那是正常档案，目录在场反而会误杀合法改写）；
 *   - 新值 `保留` ⇒ 该叶不改；其余按名**整叶替换**（连同它的续行一起换掉，
 *     不是追加）；
 *   - 解析不到任何行 ⇒ 抛错，**不启发式猜**；
 *   - 改完校验三道：块键清单与叶键清单逐项相等（骨架完整、叶数不减、叶名
 *     未被改写）、形态可判定时无新增完全同值组（脚本侧唯一有把握的那条判据）。
 *
 * 「行数与声明的对数相符」在本实现里落成一组可机判的不变量：解析到了行、每行
 * 切得出两段、叶名命中档案、同一个叶不被点名两次、至少一条可执行改写、改写值
 * 与原值不归一化同值。「声明的对数」在那份返回格式里不是一个量——模型没被要求
 * 输出它，按它机判只能去猜行数的期望公式（重复对数 ×2 之类），而那正是同一条
 * 契约禁止的启发式猜。
 *
 * **返回格式按单行值设计，而按行切分分不清「续行」与「下一条结论」**：模型若把
 * 某个改写值写成两行、第二行又恰好形似一条合法 `块.叶 → 值`，它会被当成两条
 * 改写各自套用（改后校验照样全绿——骨架与叶名都没变）。堵这个洞只能改返回格式
 * 契约（值定长或加引号包裹），那是比这轮更大的决定，本实现不做，只在这里把边界
 * 写清楚。同理，值里含换行不是本层拒绝的理由：按行切分后单个片段结构上不可能带
 * 换行（多行值的续行没有箭头，会被「每行切成恰好两段」这条拒下）。
 */
export function applyReviewVerdict(profileText: string, reply: string): ReviewOutcome {
    if (reply.trim() === NO_DUPLICATE_ANSWER) return { kind: 'none' };

    const before = scanProfileLeaves(profileText);
    const lines = splitProfileLines(profileText);
    // 同名叶在档案里出现多次时一并改：按名套用的语义是「这个叶」的全部出现，
    // 只改其中一处会留下一份与模型结论对不上的档案（而校验照样绿）。
    const rowsByKey = new Map<string, ProfileLeafRow[]>();
    for (const row of before.leaves) {
        const key = `${row.block}${KEY_SEPARATOR}${row.leaf}`;
        const bucket = rowsByKey.get(key);
        if (bucket) bucket.push(row);
        else rowsByKey.set(key, [row]);
    }

    const namedKeys: string[] = [];
    const rewrites: PendingRewrite[] = [];
    for (const raw of reply.trim().split('\n')) {
        const line = raw.trim();
        if (line === '') continue;
        // 不变量②「每行切成恰好两段」：没有箭头的行整段不可用。
        const arrowAt = line.indexOf(VERDICT_ARROW);
        if (arrowAt < 0) throw new ReviewUnusableError(`整行不是「块.叶 → 值」形态：${line}`);
        const key = line.slice(0, arrowAt).trim().split(MODEL_KEY_SEPARATOR).join(KEY_SEPARATOR);
        const value = line.slice(arrowAt + VERDICT_ARROW.length).trim();
        if (key === '') throw new ReviewUnusableError('叶名为空');
        const rows = rowsByKey.get(key);
        if (!rows) throw new ReviewUnusableError(`点名的叶「${key}」不在档案里`);
        if (namedKeys.includes(key)) throw new ReviewUnusableError(`同一个叶被点名两次：${key}`);
        namedKeys.push(key);
        if (value === KEEP_AS_IS) continue;
        rewrites.push({ key, rows, value });
    }

    if (namedKeys.length === 0) throw new ReviewUnusableError('整段回复里解析不到任何「块.叶 → 值」行');
    // 只给结论不给改写内容＝让用户自己改（指令要求 3）：这样的回执不可用，
    // 整轮降级，而不是记成「跑过了，没改」。
    if (rewrites.length === 0) throw new ReviewUnusableError('回执里只有「保留」，没有可执行的改写值');
    for (const rewrite of rewrites) {
        // 改写值与原值完全同值＝这一轮没改到东西。留着它会把简报写成「已改写 N
        // 个字段」而档案逐字未变——那是谎，不如降级。
        if (rewrite.rows.some(row => isSameLeafValue(row.value, rewrite.value))) {
            throw new ReviewUnusableError(`叶「${rewrite.key}」的改写值与原值完全同值`);
        }
    }

    const out = [...lines];
    // 自后向前替换：前面的行号不因后续删除续行而位移（同一叶的多行是
    // 一次 splice 删掉的，顺序反了就会删错行）。
    for (const rewrite of [...rewrites].sort((a, b) => b.rows[0].lineStart - a.rows[0].lineStart)) {
        for (const row of rewrite.rows) {
            out[row.lineStart] = `${lines[row.lineStart].slice(0, row.valueStart)}${rewrite.value}`;
            out.splice(row.lineStart + 1, row.lineEnd - row.lineStart);
        }
    }
    const text = out.join('\n');

    // 改后校验第一道：骨架与叶名一个都没动（顺序也比——模型点名的叶名照抄，
    // 顺序变了意味着套用整体错位）。
    const after = scanProfileLeaves(text);
    if (after.blockKeys.join('\n') !== before.blockKeys.join('\n')) {
        throw new ReviewUnusableError('改写后顶层块清单变了');
    }
    if (after.leafKeys.join('\n') !== before.leafKeys.join('\n')) {
        throw new ReviewUnusableError('改写后叶清单变了');
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

    return { kind: 'rewritten', text, changedKeys: rewrites.map(rewrite => rewrite.key) };
}