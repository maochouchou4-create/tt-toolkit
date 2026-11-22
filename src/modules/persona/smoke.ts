/**
 * node 冒烟的 persona 机判部分：全任务提示词引擎＋api 客户端形状＋
 * store 互斥＋人设写回渲染通道。
 *
 * 设计：与 choice/smoke.ts 同构（check() 打 [persona-smoke] PASS/FAIL 行，
 * scripts/smoke.mjs 收口断言）。全部走合成数据——不依赖宿主在场数据，
 * 断言确定性；与浏览器真实数据共用同一条 storage/generation 代码路径
 * （dist 加载即覆盖）。
 *
 * 本文件（连同 [persona-smoke] 这些标记）随 dist 出包：它经 persona/index.ts
 * 进 main.ts 的 node 分支，产物里跑得起来，但整份代码与全部夹具都会随发布
 * 外发给所有装扩展的人。运行时分支保证它不在浏览器里执行，却保证不了它
 * 不被人读到——所以夹具里绝不许出现真实姓名、真实 token、真实 endpoint，
 * 一律用合成值。反例素材同理：反例正文会进提示词出厂，夹具里的「素材人名」
 * 等于把真实用户素材带进发布产物（脱敏由仓外验收命令把关，见方案判据表）。
 */
import { event_types, extension_settings, getCurrentCharacter, getTavernContext, readPresetInjectMessages, upsertPersona } from '@/host';
import { toolkitGlobalPort } from '@/global-port';
import { readPersonaDomain, writePersonaDomain } from './storage';
import { DEFAULT_TEMPLATES } from './prompts';
import { isSchemaSkeleton, parseYamlToBlocks, checkProfileShape, scanProfileLeaves } from './yaml';
import { analyzeCatalogDrift, isJudgeableLeaf, isSameLeafValue, literalDuplicateSignatures, normalizeLeafValue } from './redundancy';
import { PROFILE_PLACEHOLDER_VALUES } from '@/prompts/defaults';
import { normalizeApiBase, normalizeApiUrl, buildGenerateBody, callGenerateEndpoint } from '@/modules/apis/client';
import { useRunlogStore } from '@/modules/runlog/store';
import { readApiDomain, setProviderNoPrefill, writeApiDomain, writeJailbreakPreset } from '@/modules/apis/storage';
import { writeTaskProfiles, type TaskProfilesDomain } from '@/modules/apis/task-profiles';
import { TASK_PARAMS } from '@/modules/apis/task-defaults';
import { TASK_IDS } from '@/tasks';
import { DEFAULT_PROMPT_CONFIGS, assembleMessages, PERSONA_REVIEW_TASK_HEAD, PERSONA_CURATOR_TASK_HEAD, PERSONA_GEN_TASK_HEAD, type PersonaAssemblySources } from '@/prompts';
import {
    CATALOG_DEFINITIONS_CLOSE_TAG,
    CATALOG_DEFINITIONS_OPEN_TAG,
    NO_EXCLUSION_TEXT,
    OWNERSHIP_PAIRS,
    OWNERSHIP_TABLE_CLOSE_TAG,
    OWNERSHIP_TABLE_OPEN_TAG,
    PERSONA_BLOCK_CATALOG,
    REFERENCE_MODULES_CLOSE_TAG,
    REFERENCE_MODULES_OPEN_TAG,
    definitionRowKeysFromSchema,
    catalogKeyName,
    catalogKeySet,
    renderCatalog,
    renderCatalogDefinitions,
    renderOwnershipTable,
    type CatalogBlock,
} from '@/modules/persona/catalog';
import { runGeneration, stripYamlFence, collectWorldInfoContext, PersonaRunCancelled, type GenerationResult } from './generation';
import { renderReviewBrief, REVIEW_BRIEF_NOT_RUN } from './review';
import { TEXT } from './strings';
import { overwritePersonaGuarded, usePersonaStore } from './store';
import { createPersonaTab } from '@/shell/tabs';

interface CapturedRequest {
    url: string;
    body: {
        messages: Array<{ role: string; content: string }>;
        [key: string]: unknown;
    };
}

/**
 * 段识别：按实发 body 末条 user 消息的首行分派。
 *
 * 为什么从消息内容认段、不数「这是第几次调用」：生成链第三段（审稿）一进来，
 * 「第 N 次调用回第 M 段内容」这种派发在任何一段增删时都会整体错位，而错位不
 * 报错——档案段的 YAML 会被当审稿回执解析，降级提示一路绿灯（冒烟本身测不
 * 出）。按内容认段，加段减段都不必动桩；顺带把「审稿指令有没有真进 messages」
 * 变成桩的可观测前提：认不出审稿段，说明那一轮的指令没在场。
 *
 * 判据是「首行以该段的任务头**开头**」而非整行相等：审稿指令的任务头与它的
 * 第一句写在同一行，策展段与档案段的任务头则独占一行。
 *
 * 三个任务头都从 prompts 侧 import（三段各据自己的那份真相源）：这里再抄一份
 * 字面量，改了模板就会留下一处与被测行为无关的假红。
 */
function stageOfRequest(body: CapturedRequest['body'] | undefined): 'curator' | 'personaGen' | 'personaReview' | 'unknown' {
    const messages = body?.messages ?? [];
    const lastUser = [...messages].reverse().find(message => message.role === 'user');
    const head = (lastUser?.content ?? '').split('\n')[0];
    if (head.startsWith(PERSONA_CURATOR_TASK_HEAD)) return 'curator';
    if (head.startsWith(PERSONA_REVIEW_TASK_HEAD)) return 'personaReview';
    if (head.startsWith(PERSONA_GEN_TASK_HEAD)) return 'personaGen';
    return 'unknown';
}

/**
 * 该段请求是否带着起手词（请求末条是 assistant 轮）。两轮带：策展段与档案段；
 * 审稿轮不带（输出两态：无可挑剔只回「无需修改」四字，有修订才回整份档案——YAML
 * 起手词会把模型钉在续写态上，压掉「无需修改」那一态）。
 */
function endsWithPrefill(body: CapturedRequest['body'] | undefined): boolean {
    const messages = body?.messages ?? [];
    return messages[messages.length - 1]?.role === 'assistant';
}

/** SSE 单帧响应（流式恒开——TASK_PARAMS：content 走 delta 帧）；抽到模块级给审稿探针段复用。 */
function sseResponse(content: string): Response {
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => {
                const encoder = new TextEncoder();
                const frames = [
                    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
                    encoder.encode('data: [DONE]\n\n'),
                ];
                return {
                    read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true },
                    cancel: async () => undefined,
                };
            },
        },
    } as unknown as Response;
}

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
    console.info(`[persona-smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

/**
 * 结构逐项相等（夹具期望值一律字面量写死，不从被测对象反推——反推的期望值
 * 只会把实现变成它自己的断言）。
 */
function jsonEq(actual: unknown, expected: unknown): boolean {
    return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * 全任务档案统一种子（全部指向同一服务商＋模型——端到端/审稿/互斥分区的
 * 档案前置）。
 */
function seedTaskProfiles(providerId: string, model: string): void {
    const profiles = {} as TaskProfilesDomain;
    for (const id of TASK_IDS) profiles[id] = { providerId, model };
    writeTaskProfiles(profiles);
}

// ---------------------------------------------------------------------------
// 2) 全任务提示词引擎（存储形态＋默认模板＋任务键）
// ---------------------------------------------------------------------------

/**
 * 提示词里三种键形态的目录基准集。键名与块名的真相源就是目录本身：从目录
 * 推出的键集在这里是对的基准（要判的是「提示词有没有指向目录外的键」，
 * 不是「提示词有没有抄对目录」）——不能拿来反推该出现哪些键，那才是同源恒绿。
 */
const CATALOG_LEAF_KEYS: ReadonlySet<string> = new Set(PERSONA_BLOCK_CATALOG.flatMap(block => [
    ...block.leaves.flatMap(leaf => ('name' in leaf ? [`${block.name}·${leaf.name}`] : [])),
    ...(block.optionalLeaf ? [`${block.name}·${block.optionalLeaf.name}`] : []),
]));
const CATALOG_BLOCK_NAMES: ReadonlySet<string> = new Set(PERSONA_BLOCK_CATALOG.map(block => block.name));
const CATALOG_LEAF_NAMES: ReadonlySet<string> = new Set([
    ...PERSONA_BLOCK_CATALOG.flatMap(block => block.leaves.flatMap(leaf => ('name' in leaf ? [leaf.name] : []))),
    ...PERSONA_BLOCK_CATALOG.flatMap(block => (block.optionalLeaf ? [block.optionalLeaf.name] : [])),
]);

/**
 * 档案段正文里的「块名·叶名」形态串（键指针与括注互指的公共提取口径）。两侧
 * 贪到非汉字数字为止——键名全是中文，所以右界干净；左界会连带前导散文，那由
 * resolveCatalogKey 回退到真实块名后缀解决。
 */
const DOT_KEY_PATTERN = /[\p{Script=Han}A-Za-z0-9]+·[\p{Script=Han}A-Za-z0-9]+/gu;

/**
 * 把正文里切出的「X·Y」候选还原成目录键：X 侧常带前导散文（「动手层面不会归
 * 技能专长·技能盲区」），从长到短试它的后缀，第一个能命中真实叶子键的即成键。
 * 全部后缀都落空则原样退回 null——那才是真的指向目录外（或者块名写错了），
 * 由判据报错，不在这里悄悄放过。
 */
function resolveCatalogKey(token: string): string | null {
    const at = token.indexOf('·');
    const left = token.slice(0, at);
    for (let i = 0; i < left.length; i++) {
        const candidate = `${left.slice(i)}·${token.slice(at + 1)}`;
        if (CATALOG_LEAF_KEYS.has(candidate)) return candidate;
    }
    return null;
}

function runPromptsChecks(): void {
    // 默认模板改读代码常量（DEFAULT_PROMPT_CONFIGS）后，域存储与版本化
    // 重建机器已随 tt-slim 批 C 退役——本段只剩模板正文的机判锁。
    const curatorText = DEFAULT_PROMPT_CONFIGS.persona_curator.modules.find(m => m.kind === 'text')?.content ?? '';
    const genText = DEFAULT_PROMPT_CONFIGS.persona_gen.modules.find(m => m.kind === 'text')?.content ?? '';
    check('prompts：curator 默认模板占位符（{{charInfo}}/{{userRequirements}}）',
        curatorText.includes('{{charInfo}}') && curatorText.includes('{{userRequirements}}'));
    check('prompts：persona_gen 默认模板占位符（{{charInfo}}/{{greetings}}/{{template}}/{{catalog_definitions}}/{{input}}）',
        genText.includes('{{charInfo}}')
        && genText.includes('{{greetings}}') && genText.includes('{{template}}')
        && genText.includes('{{catalog_definitions}}')
        && genText.includes('{{input}}'));

    // ── 渲染契约：锁形状与接线，不锁散文 ──
    // 提示词措辞属产品迭代面，散文回归归 diff 评审；逐字锁的唯一失效模式是
    // 忘了同步簿记——红的是测试不是代码。机器守两条：渲染/组装的形状契约
    // （改格式在此红）、跨源接线（正文互指的键必须落在目录真实键上，改数据
    // 在此红）。同源期望在形状位上合法：判的是渲染函数守不守格式，不是数据
    // 该长什么样。

    // 清单行形：每块一行「块名——叶名串；N 叶；档位/条件词面…」。叶名串按
    // 目录现值拼——它由 renderCatalog 内部同式拼出，只有渲染函数改了拼法
    // （丢块、丢叶名、叶数段变形）才在此红；改词面不红是设计如此。
    const refModuleText = curatorText.split(REFERENCE_MODULES_OPEN_TAG)[1]?.split(REFERENCE_MODULES_CLOSE_TAG)[0] ?? '';
    const renderRows = refModuleText.split('\n').filter(l => l.includes('——') && l.includes('；'));
    const rowShapeBroken = PERSONA_BLOCK_CATALOG.filter((block, i) => {
        const row = renderRows[i] ?? '';
        return !row.startsWith(`${block.name}——`)
            || !row.includes(block.leaves.map(l => l.name).join('/'))
            || !/；\d+ 叶；/.test(row);
    }).map(block => block.name);
    check('prompts：策展清单行形契约（块名——叶名串；N 叶；…·行数＝块数）',
        renderRows.length === PERSONA_BLOCK_CATALOG.length && rowShapeBroken.length === 0,
        `行数=${renderRows.length} 块=${PERSONA_BLOCK_CATALOG.length} 破形块=${rowShapeBroken.join('/') || '无'}`);

    // 回退骨架行形：块行顶格、叶行恰两格缩进、一律半角「:」收尾无值——切块
    // 解析与策展模型的阅读都吃这个形状。骨架内容由目录骨架标记派生（同源），
    // 数据对不对归目录评审，这里只锁形状可解析。
    const skeletonLines = DEFAULT_TEMPLATES.user.split('\n').filter(Boolean);
    const skeletonShapeOk = skeletonLines.length > 0
        && skeletonLines.every(l => /^[^\s:][^:]*:$/.test(l) || /^ {2}[^:]+:$/.test(l));
    check('prompts：回退骨架行形契约（块行顶格·叶行两格·键冒号收尾无值）',
        skeletonShapeOk && parseYamlToBlocks(DEFAULT_TEMPLATES.user).size > 0,
        `行数=${skeletonLines.length}`);

    // 归属对两端必须落在目录真实叶上：写裸块名或已改名的键，结构重复判定对
    // 那几对永远静默。对内容（几对、谁配谁）是数据设计，归目录评审，这里只
    // 守接线。
    const catalogLeafKeys = new Set(PERSONA_BLOCK_CATALOG.flatMap(
        block => block.leaves.map(leaf => `${block.name}·${leaf.name}`),
    ));
    const pairEndsMissing = OWNERSHIP_PAIRS.flatMap(([a, b]) => [a, b]).filter(key => !catalogLeafKeys.has(key));
    check('prompts：归属优先级对两端全落在目录真实叶上',
        pairEndsMissing.length === 0,
        `未落地的叶=${pairEndsMissing.join('/') || '无'}`);

    // 条件叶：成文在叶名串之后、叶数段之前（排到叶数段之后会被读成多出来的
    // 一叶）；叶数位＝声明叶数（把条件叶计进去即红，期望从目录字段派生，与
    // 渲染同式）；不进回退骨架。
    const optionalBlock = PERSONA_BLOCK_CATALOG.find(block => block.optionalLeaf);
    const optionalName = optionalBlock?.optionalLeaf?.name ?? '';
    const optionalMarker = optionalName ? `【${optionalName}】` : '';
    const optionalRow = optionalBlock ? renderRows.find(line => line.startsWith(`${optionalBlock.name}——`)) ?? '' : '';
    check('prompts：条件叶成文在叶名串之后·叶数段之前（不占声明叶数·不进回退骨架）',
        !optionalBlock || !optionalName
        || (optionalRow.includes(`${optionalMarker}；${optionalBlock.leaves.length} 叶；`)
            && !DEFAULT_TEMPLATES.user.includes(optionalName)),
        `条件叶=${optionalName || '无'} 成文=${optionalRow.includes(optionalMarker)}`);

    // 目录里有条件叶时，策展指令必须交代它的例外规则——两处独立维护（目录
    // 数据、指令正文），目录加条件叶而指令没跟上，策展模型就不知道该叶的
    // 选用口径。叶名从目录派生，不手抄第二份。
    const optionalUnmentioned = PERSONA_BLOCK_CATALOG
        .filter(block => block.optionalLeaf && !curatorText.includes(block.optionalLeaf.name))
        .map(block => block.optionalLeaf?.name ?? '');
    check('prompts：策展指令交代条件叶例外（按目录 optionalLeaf 名派生）',
        optionalUnmentioned.length === 0,
        `未交代=${optionalUnmentioned.join('/') || '无'}`);

    // 定义非空率：每叶的边界定义是策展模型的唯一依据（渲染文本之外它无处可
    // 见），漏填一叶在数据上无痕、只在效果上无痕。
    const definitionEntries = PERSONA_BLOCK_CATALOG.flatMap(block => [
        ...block.leaves,
        ...(block.optionalLeaf ? [block.optionalLeaf] : []),
    ]);
    const undefinedLeaves = definitionEntries.filter(entry => !entry.definition.trim());
    check('prompts：目录 definition 非空率 100%（逐叶都有边界定义·且已渲染成文）',
        undefinedLeaves.length === 0 && renderCatalog().includes('｜'),
        `定义条目=${definitionEntries.length} 空定义=${undefinedLeaves.length}`);

    check('prompts：机制挂载开放段在场', curatorText.includes('<mechanism_mounts>'));

    // 档案段「→」归属处必须落在目录里（指块或「块名·叶名」）：目录改名后
    // 这些手写指针不会自己跟着改，模型会拿到一份自相矛盾的归属表。切片锚是
    // 要求 6 的条头——条头改字时此处红，属于锚点维护（一处），不是散文锁。
    const require6Text = genText.slice(genText.indexOf('6. 事实唯一归属'), genText.indexOf(OWNERSHIP_TABLE_OPEN_TAG));
    const arrowAtoms = [...require6Text.matchAll(/→\s*([^；，。\s（(]+)/g)].map(m => m[1]);
    const unknownTargets = arrowAtoms.filter(a => (a.includes('·') ? resolveCatalogKey(a) === null : !CATALOG_BLOCK_NAMES.has(a)));
    check('prompts：档案段要求 6 的归属处全落在目录（每个「→」目标是真实块名或「块名·叶名」）',
        arrowAtoms.length > 0 && unknownTargets.length === 0,
        `目标数=${arrowAtoms.length} 目录外=${unknownTargets.join('/') || '无'}`);

    // 归属优先级表：提示词里那份必须是 catalog 从 OWNERSHIP_PAIRS 渲染出来的
    // 接线位——表体单源派生，手抄进模板即在此红。
    const ownershipSection = genText.split(OWNERSHIP_TABLE_OPEN_TAG)[1]?.split(OWNERSHIP_TABLE_CLOSE_TAG)[0] ?? '';
    check('prompts：档案段归属优先级表由 catalog 渲染（标签在场＋整段＝renderOwnershipTable）',
        ownershipSection === '\n' + renderOwnershipTable() + '\n',
        `段长=${ownershipSection.length} 渲染=${renderOwnershipTable().length}`);

    // 叶边界段在档案段是宏位（成文按本次策展 schema 收敛）：段体只有宏位、
    // 标签在外——宏位把段标签一起吞掉的话，切片就看不到标签有没有被填。
    const definitionSection = genText.split(CATALOG_DEFINITIONS_OPEN_TAG)[1]?.split(CATALOG_DEFINITIONS_CLOSE_TAG)[0] ?? '';
    check('prompts：档案段叶边界段是宏位（模板段体＝{{catalog_definitions}}·标签在外）',
        definitionSection === '\n{{catalog_definitions}}\n',
        `模板段=${JSON.stringify(definitionSection)}`);

    // 叶边界段静态成文：一叶一行、行首「块名」或「块名·叶名」落在真实块上
    // （行首点名由渲染派生，这里守的是行形与点名可解析）。
    const staticDefinitionLines = renderCatalogDefinitions().split('\n');
    const definitionRows = staticDefinitionLines.filter(l => l.indexOf('：') > 0);
    const rowNamesValid = definitionRows.every(row => {
        const name = row.slice(0, row.indexOf('：'));
        return PERSONA_BLOCK_CATALOG.some(block => name === block.name || name.startsWith(`${block.name}·`));
    });
    check('prompts：叶边界段静态成文一叶一行（每行冒号起头·行首落在真实块）',
        definitionRows.length > 0 && rowNamesValid,
        `行数=${definitionRows.length} 点名=${rowNamesValid}`);

    // 跨叶互指：排除半句「（…）」指着别的叶，叶改名后这些指针会静默失效——
    // 档案段照着排除一个不存在的键，本叶真正的边界反而没人守。解析按形态：
    //   ① 含「·」＝「块名·叶名」键指针，必须命中 CATALOG_LEAF_KEYS；
    //   ② 带「」＝散文连写里的指针，只判引号内那半句，命中叶名或块名即可；
    //   ③ 其余裸原子必须命中叶名或块名。
    const parenProblems: string[] = [];
    for (const row of definitionRows) {
        const body = row.slice(row.indexOf('：') + 1);
        for (const paren of body.matchAll(/（([^（）]*)）/g)) {
            for (const atom of paren[1].split(/[、，]/).map(a => a.trim()).filter(Boolean)) {
                const quoted = atom.match(/「([^」]+)」/);
                const pointer = quoted ? quoted[1] : atom;
                if (pointer.includes('·')) {
                    if (!CATALOG_LEAF_KEYS.has(pointer)) parenProblems.push(`${pointer}（键）`);
                } else if (!CATALOG_LEAF_NAMES.has(pointer) && !CATALOG_BLOCK_NAMES.has(pointer)) {
                    parenProblems.push(`${pointer}（裸名）`);
                }
            }
        }
    }
    check('prompts：叶边界段排除半句的跨叶互指全落在目录真实键上（块·叶／裸叶名／裸块名）',
        parenProblems.length === 0,
        `目录外指针=${parenProblems.join(',') || '无'}`);

    // 没有「不装：」半句的叶必须为 0：这类叶在定义段只能落兜底句，而兜底句
    // 换不到任何边界信息（目录数据漏写「不装：」时该叶的边界即失守且无声）。
    // 兜底句从 catalog 导入：它是随提示词出厂的正文，抄第二份等于允许两边
    // 各漂各的。
    const fallbackLines = definitionRows.filter(l => l.endsWith(NO_EXCLUSION_TEXT));
    check('prompts：叶边界定义段无「不装」半句的叶＝0（兜底句零处）',
        fallbackLines.length === 0,
        `兜底叶=${fallbackLines.map(l => l.split('：')[0]).join('/') || '无'}`);
}

// ---------------------------------------------------------------------------
// 3) persona 任务组装管线（引擎多任务化——choice 路径零行为变化红线在
//    choice/smoke.ts 的 90 条断言）
// ---------------------------------------------------------------------------

// 策展 schema 夹具：目录内普通叶（身份定位）、目录外的叶（年龄）与条件叶
// （【类型学速记】）各带一处，条件叶下再挂一个缩进更深的子键——收敛口径的三
// 条边界一条都不靠猜：命中、出行（目录外叶）、不出行（深层子键）。
const assemblySources: PersonaAssemblySources = {
    wiText: '> [FILE: 设定书]\n"""\n魔法世界\n"""',
    charInfo: '林霜，温柔',
    greetings: '「你好，旅行者」',
    userRequest: '写个侦探',
    curatedSchema: '基本信息:\n  身份定位:\n  年龄:\n性格:\n  核心矛盾:\n  【类型学速记】:\n    分项:',
    userName: '王玉',
    charName: '林霜',
};

function runPersonaAssemblyChecks(): void {
    // curator 管线：wi 一条 system（任务级预设源已退役——预设影响走传输层
    // 破限注入，不进引擎），user 指令占位符清零
    const curator = assembleMessages(DEFAULT_PROMPT_CONFIGS.persona_curator.modules, assemblySources);
    check('persona 组装：curator 管线（wi system＋user 指令、占位符清零、无预设段）',
        curator.messages.length === 2
        && curator.messages[0].role === 'system'
        && curator.messages[0].content.includes('魔法世界') && !curator.messages[0].content.includes('你是人设生成器')
        && curator.messages[1].role === 'user'
        && curator.messages[1].content.includes('林霜，温柔') && curator.messages[1].content.includes('写个侦探')
        && !curator.messages[1].content.includes('{{charInfo}}') && !curator.messages[1].content.includes('{{userRequirements}}'));

    // gen 管线：{{template}}←策展 schema、{{greetings}}、{{input}} 全填；
    // 指令层无 {{user}} 宏——User 锚定行直接进正文
    const gen = assembleMessages(DEFAULT_PROMPT_CONFIGS.persona_gen.modules, assemblySources);
    const genUser = gen.messages[gen.messages.length - 1].content;
    check('persona 组装：persona_gen 管线（占位符全部填充＋User 锚定行在场）',
        gen.messages.length === 2 && gen.messages[1].role === 'user'
        && genUser.includes('User——使用者本人的扮演身份') && genUser.includes('林霜，温柔')
        && genUser.includes('「你好，旅行者」') && genUser.includes('性格:\n  核心矛盾:\n  【类型学速记】:')
        && genUser.includes('写个侦探') && !genUser.includes('{{'));

    // 反向守门（扩成三类跨段标记）：「原则 N」「要求 N」「策展段」都只存在于策展段，
    // 档案段引用它们＝写一条本次请求里不存在的约束（要填的键集合由
    // <target_schema> 定死，它既读不到策展段的职责交代，也读不到策展段的规则
    // 编号）。扫填充后的整条 user 消息而不是模板正文：模板里叶边界段还是宏位，
    // 只扫模板会把「由策展段保证」这类引用漏在射程外——那正是这条守门要拦的。
    const CROSS_SECTION_MARKERS = [/原则\s*\d/u, /要求\s*\d/u, /策展段/u];
    const crossSectionHits = CROSS_SECTION_MARKERS.filter(re => re.test(genUser)).map(re => re.source);
    check('persona 组装：档案段正文零跨段引用（原则 N／要求 N／策展段三类标记全扫）',
        crossSectionHits.length === 0,
        `命中=${crossSectionHits.join(',') || '无'}`);

    // 档案段正文里每一个「块名·叶名」形态串都必须落在目录真实键上：要求 6 的
    // 归属顺序、三组反例的叶键、叶边界段的行首点名走的是同一个口径。手抄的键
    // 名在目录改名后不会自己跟着改（归属表会改、这些不会），模型于是拿到一份自相
    // 矛盾的档案段指令：边界段与归属表讲新键，指令讲旧键。全域扫而不是分区扫——
    // 分区清单以外那些静默失效的正是漏网的部分。
    const bodyKeyTokens = [...new Set(genUser.match(DOT_KEY_PATTERN) ?? [])];
    const unknownKeyTokens = bodyKeyTokens.filter(t => resolveCatalogKey(t) === null);
    check('persona 组装：档案段正文的「块名·叶名」全落在目录真实键上（含要求 6／三组反例／叶边界段行首）',
        bodyKeyTokens.length > 0 && unknownKeyTokens.length === 0,
        `键指针=${bodyKeyTokens.length} 目录外=${unknownKeyTokens.join('/') || '无'}`);

    // 收敛形态：行集写成字面量，不从过滤函数反推（反推即同源恒绿，只证明两边
    // 一致）。三条各有来路——普通叶命中、条件叶按方括号名命中、目录外的叶
    // （年龄）与条件叶的深层子键（分项）不出行：「schema 里没有的键一律不输出」
    // 这条口径就靠后一条守。
    const assembledDefinitionSection = genUser.split(CATALOG_DEFINITIONS_OPEN_TAG)[1]?.split(CATALOG_DEFINITIONS_CLOSE_TAG)[0] ?? '';
    const assembledRowNames = assembledDefinitionSection.split('\n')
        .filter(l => l.indexOf('：') > 0)
        .map(l => l.slice(0, l.indexOf('：')));
    const CONVERGED_ROW_EXPECT = ['基本信息·身份定位', '性格·核心矛盾', '性格·类型学速记'];
    check('persona 组装：档案段叶边界段随本次 schema 收敛（行集＝字面量三行·目录外的叶与深层子键不出行）',
        assembledRowNames.length === CONVERGED_ROW_EXPECT.length
        && assembledRowNames.every((n, i) => n === CONVERGED_ROW_EXPECT[i]),
        `行集=${assembledRowNames.join('/') || '无'}`);

    // 逐字节锁跟着形态改：比的是填充后的成文（原来比的是模板里的宏位——那已经
    // 不是成文了），期望取自同一个收敛函数，兜住「行集对但行身被换过」。
    const convergedDefinitions = renderCatalogDefinitions(definitionRowKeysFromSchema(assemblySources.curatedSchema));
    check('persona 组装：档案段叶边界段整段逐字节＝按本次 schema 收敛的成文（段头同源·无第二份手抄）',
        assembledDefinitionSection === `\n${convergedDefinitions}\n`,
        `段长=${assembledDefinitionSection.length} 收敛渲染=${convergedDefinitions.length}`);

    // 模块开关闭环：关指令模块→user 消失 trace 留痕；开回→恢复。
    // 提示词编辑面已删（toggleModule action 同删）——
    // 改本地数组改造（choice smoke modulesOff 同款；modules[].enabled
    // 字段保留、引擎照读的实证）
    const genModules = DEFAULT_PROMPT_CONFIGS.persona_gen.modules;
    const offModules = genModules.map(m => (m.id === 'persona_gen_prompt' ? { ...m, enabled: false } : m));
    const off = assembleMessages(offModules, assemblySources);
    const offTrace = off.trace.find(t => t.moduleId === 'persona_gen_prompt');
    const offOk = off.messages.length === 1 && off.messages[0].role === 'system' && offTrace?.note === '模块已停用';
    const on = assembleMessages(genModules, assemblySources);
    check('persona 组装：模块开关闭环（停用留痕不注入、启用恢复注入）',
        offOk && on.messages.length === 2 && on.messages[1].role === 'user');
}

/** dump 观测口断言（异步——__TT_TOOLKIT__.prompts.dump 按任务返回全文）。 */
async function runPersonaAssemblyDumpChecks(): Promise<void> {
    const port = (toolkitGlobalPort().prompts as { dump: (task?: string) => Promise<string> } | undefined);
    const dumpText = await (port ? port.dump('persona_gen') : Promise.reject(new Error('口缺席')));
    check('dump 口：按任务 dump 全文（persona_gen：组装 dump 标头＋模块清单＋指令正文）',
        dumpText.includes('=== 消息组装 dump') && dumpText.includes('生成指令')
        && dumpText.includes('[任务：生成用户人设]'));
    // 观测面口径：dump 的消息段含传输层破限前缀段——
    // 冒烟桩未选预设 → 标注「无传输层前缀」；选中预设的场景由 stub 破限
    // 断言覆盖（jb 前缀进消息序列 = 同一 composeOutbound 实现）
    check('dump 口：观测口径标注传输层前缀状态（未选预设＝无传输层前缀）',
        dumpText.includes('消息数组（') && dumpText.includes('无传输层前缀'));
    let thrownUnknown = false;
    try {
        await port?.dump('bogus');
    } catch (e) {
        thrownUnknown = (e as Error).message.includes('未知任务键');
    }
    check('dump 口：未知任务键 fail fast（提示可选值）', thrownUnknown);
}

// ---------------------------------------------------------------------------
// 4) yaml 纯函数行为
// ---------------------------------------------------------------------------

function runPureFunctionChecks(): void {
    // 多顶层键分块
    const blocks = parseYamlToBlocks('基本信息:\n  姓名: 测试\n外貌:\n  概貌: 高个\n');
    check('yaml：多顶层键分块（键集合与内联缩进值）',
        blocks.size === 2 && (blocks.get('基本信息')?.includes('姓名: 测试') ?? false) && (blocks.get('外貌')?.includes('概貌: 高个') ?? false));

    // 剥围栏
    check('yaml：```yaml 围栏剥除',
        parseYamlToBlocks('```yaml\n姓名: 测试\n```').get('姓名') !== undefined);

    // 单顶层键嵌套（模型把全部子块缩进在唯一顶层键下）→ 余行去缩进后
    // 子键提升为顶层键（旧 fork 契约：唯一顶层键本身被丢弃）
    const nested = parseYamlToBlocks('基本信息:\n  姓名: 测试\n  年龄: 20\n');
    const nestedKeys = [...nested.keys()];
    check('yaml：单顶层键误嵌套修复（余行去缩进、子键提升为顶层键）',
        nestedKeys.includes('姓名') && nestedKeys.includes('年龄')
        && (nested.get('姓名') ?? '').includes('测试') && (nested.get('年龄') ?? '').includes('20'),
        `keys=${nestedKeys.join('/')}`);

    // stripYamlFence：围栏提取 + prefill 补回判定
    check('stripYamlFence：围栏内提取 trim',
        stripYamlFence('```yaml\n姓名: 测试\n```') === '姓名: 测试');
    check('stripYamlFence：prefill 未闭合（首行是键行）补 prefill 再剥',
        stripYamlFence('身份定位: 城南码头3号泊位的夜班调度\n别名与名号: 街面上都叫他「阿槐」', '```yaml\n基本信息:') === '基本信息:身份定位: 城南码头3号泊位的夜班调度\n别名与名号: 街面上都叫他「阿槐」'
        || stripYamlFence('身份定位: 城南码头3号泊位的夜班调度\n别名与名号: 街面上都叫他「阿槐」', '```yaml\n') === '身份定位: 城南码头3号泊位的夜班调度\n别名与名号: 街面上都叫他「阿槐」');
    // 首块键 ≠「基本信息」的用例：上面两条的 prefill 起手词恒为「基本信息」
    // 或空，块键判据换首块名后没有一条断言会红，而首块名将来是随目录块序
    // 变的（骨架首块＝目录第一个带骨架叶的块）。正文从 prefill 的块键本身
    // 起首＝模型从围栏头之后接写，这时必须把围栏头补回去。
    const headKeyPrefill = '```yaml\n外貌:';
    check('stripYamlFence：首块键非「基本信息」时正文接写补围栏头起首（块键判据生效）',
        stripYamlFence('外貌: 高个冷峻\n  辨识标记: 疤', headKeyPrefill) === '外貌:外貌: 高个冷峻\n  辨识标记: 疤',
        `实得「${stripYamlFence('外貌: 高个冷峻\n  辨识标记: 疤', headKeyPrefill)}」`);
    // 反向机判（判据不恒真）：散言前导不是键行，不得把起手词黏上去——判据若
    // 退化成对任何正文都成立，上面的正例断言照样绿。散言样本与 isSchemaSkeleton
    // 的「散言前导出局」共用同一拒判基础（子句标点不进键名）。
    check('stripYamlFence：散言前导不补围栏头（判据不恒真）',
        stripYamlFence('好的，以下是为你定制的档案：\n基本信息:\n  身份定位: 城南码头3号泊位的夜班调度', headKeyPrefill) === '好的，以下是为你定制的档案：\n基本信息:\n  身份定位: 城南码头3号泊位的夜班调度',
        `实得「${stripYamlFence('好的，以下是为你定制的档案：\n基本信息:\n  身份定位: 城南码头3号泊位的夜班调度', headKeyPrefill)}」`);
    // 目录现值形态的正例：基本信息 的首叶是「身份定位」（catalog.ts 现值），
    // 旧判据只认「姓名」时这种续写被漏判——首块头静默丢失、首块叶逃出审稿轮的
    // 叶级守卫。判据改认行形态（严格键行）后必须补头成功。
    check('stripYamlFence：首叶行（目录现值「身份定位」）补 prefill 再剥',
        stripYamlFence('身份定位: 城南码头3号泊位的夜班调度\n别名与名号: 街面上都叫他「阿槐」', '```yaml\n基本信息:') === '基本信息:身份定位: 城南码头3号泊位的夜班调度\n别名与名号: 街面上都叫他「阿槐」',
        `实得「${stripYamlFence('身份定位: 城南码头3号泊位的夜班调度\n别名与名号: 街面上都叫他「阿槐」', '```yaml\n基本信息:')}」`);

    // isSchemaSkeleton：策展产出的可用性判据。事故原型——宿主错误正文里
    // 「连接目标服务失败：」「请求地址: …」都是合法的「键行」形态，旧判据
    // （切得出顶层键即合法）把它判成可用 schema 送进第二段。新判据要求
    // 每一行都是键/缩进内容/列表项，顶格散文出局。
    check('yaml：骨架判据放行真骨架（含缩进叶与围栏）',
        isSchemaSkeleton('```yaml\n基本信息:\n  年龄:\n  性别:\n外貌:\n  整体印象:\n```')
        && isSchemaSkeleton(DEFAULT_TEMPLATES.user));
    check('yaml：骨架判据拦下宿主错误正文（顶格散文行出局）',
        !isSchemaSkeleton('[API 错误]\n连接目标服务失败：当前网络、VPN、代理或接口地址可能暂时不可用。\n\n请检查网络连接、VPN、代理或自定义接口地址，然后重试。\n\n请求地址: https://api.example.com/provider/v1/chat/completions'));
    check('yaml：骨架判据拦下空响应与纯散文',
        !isSchemaSkeleton('') && !isSchemaSkeleton('   \n\t ')
        && !isSchemaSkeleton('好的主人，您的骚母狗已经完全准备好了，请主人下达指令。'));
    // 换皮形态：散言前导（带子句标点的句子）被宽松键正则认成顶层键时，
    // 该键会被 profilePrefillFor 派生成第二段起手词＝把错误正文再送进去
    // 一次。严格键名（排除子句标点）＋顶层键 ≥2 双条件拦下它。
    check('yaml：骨架判据拦下散言前导+真骨架（换皮形态：prefill 首键不得落在散文句上）',
        !isSchemaSkeleton('好的，以下是为您定制的骨架：\n基本信息:\n  年龄:\n外貌:\n  整体印象:')
        && !isSchemaSkeleton('请求地址: https://api.example.com/v1')
        && !isSchemaSkeleton('基本信息:\n  年龄:\n  性别:'),  // 单顶层键不足（真骨架至少两块）
        '换皮形态与单键形态都应出局');
    // 校验与切块必须共用同一「块界」定义：1 空格缩进、键名带标点的行
    // 会被宽松切块当新顶层块，校验若把它当「缩进内容从宽」就出现
    // 「判据说这是骨架、切块给出的却不是这个形状」的分歧（双复核实锤）。
    // 该形态必须出局——它的块值会截断真骨架并多出空块进第二段注入。
    // 作用域：策展段那一路（`parseYamlToBlocks` 与 `isSchemaSkeleton` 共享的
    // `isTopLevelKeyLine`）。档案段那一路由 `scanProfileLeaves` 自带另一条块界
    // 定义（缩进 0 ＝ 块，其余都是叶），本条不断言它——判据层那侧的对照由
    // 下面 4b 段的加固③（及其反向用例）把关。
    check('yaml：策展段骨架判据与切块共用块界定义（1 空格缩进的散言行不得放行）',
        !isSchemaSkeleton('基本信息:\n 年龄:\n 备注，注意如下:\n外貌:\n  整体印象:'),
        '该行会被切块当顶层块，校验必须同判');
}

// ---------------------------------------------------------------------------
// 4b) 档案叶级解析加固六处 ＋ 确定性重复判据探针
// ---------------------------------------------------------------------------

/**
 * 夹具自带内联目录：手挑的 7 块 16 叶（REDUNDANCY_SAMPLE 的叶集，加上
 * MECHANISM/ORPHAN 夹具要用的 基本信息·年龄/性别/身份）——刻意不与逐字档的
 * 锚点目录逐一对齐：本组探针要的是一份**自有节奏**的目录，好让「目录外叶」
 * 这类期望值不被目录增删带着抖。真目录漂移另由末尾那条「按默认目录跑」断言
 * 把关。
 */
const FIXTURE_CATALOG_SPEC: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ['基本信息', ['年龄', '性别', '身份', '身份定位', '别名与名号']],
    ['外貌', ['整体印象', '辨识标记']],
    ['性格', ['核心矛盾']],
    ['言谈习惯', ['口头禅与语气词', '说话方式']],
    ['底线雷区', ['绝不做的事', '行为禁区', '禁触话题']],
    ['目标动机', ['外部义务', '深层需要']],
    ['既有关系', ['专属称谓']],
];
const FIXTURE_CATALOG: ReadonlyArray<CatalogBlock> = FIXTURE_CATALOG_SPEC.map(([name, leafNames]) => ({
    name,
    tier: 'common' as const,
    leaves: leafNames.map(leafName => ({ name: leafName, definition: '' })),
}));

/**
 * 形态夹具一（加固①）：三处空值叶 ＋ 一个列表承载叶。两者取到的都是空串，
 * 不先排除就是 4 叶两两互判「完全同值」＝6 对命中，且这 6 对会点着自动改写
 * ——对着留白的档案批量覆写。
 */
const EMPTY_AND_LIST_LEAF_YAML = [
    '基本信息:',
    '  年龄:',
    '  性别:',
    '  身份:',
    '喜恶:',
    '  喜欢:',
    '    - 旧版平装书',
    '    - 手冲咖啡',
    '兴趣嗜好:',
    '  爱好:',
].join('\n');

/**
 * 形态夹具二（加固②）：档案段 prefill 起首是「基本信息:」，模型从冒号之后接写，
 * 首叶因此落在**块首行**上而不是缩进行上——只认缩进的读法把它整条丢掉。
 */
const INLINE_FIRST_LEAF_YAML = [
    '基本信息:年龄: 三十四',
    '  性别: 男',
    '外貌:',
    '  整体印象: 瘦高，肩线绷得很直',
].join('\n');

/** 形态夹具三（加固③）：模型常用 1 空格缩进子键。 */
const ONE_SPACE_INDENT_YAML = [
    '基本信息:',
    ' 年龄: 三十四',
    ' 性别: 男',
    '外貌:',
    ' 整体印象: 瘦高，肩线绷得很直',
].join('\n');

/** 形态夹具四（加固④）：单块档案——会踩「单顶层键整块去缩进」的修复分支。 */
const SINGLE_BLOCK_YAML = ['基本信息:', '  年龄: 三十四', '  性别: 男'].join('\n');

/** 形态夹具五（加固⑤）：机制挂载块按该世界的原生词汇命名，键名带空格与连字符。 */
const MECHANISM_NAMED_YAML = [
    '基本信息:',
    '  年龄: 三十四',
    '底牌机制:',
    '  HP 成长: 每场交手后上限加一格',
    '  冷却-判定: 连续命中三次才生效',
].join('\n');

/** 形态夹具六（加固⑥）：宿主错误正文——顶格散文与整行键，档案段此前从不跑形状校验。 */
const HOST_ERROR_ENVELOPE_YAML = [
    '[API 错误]',
    '连接目标服务失败：当前网络、VPN、代理或接口地址可能暂时不可用。',
    '',
    '请求地址: https://api.example.com/v1/chat/completions',
].join('\n');

/**
 * 形态夹具七：宿主错误正文的另一种形态——**凑够两个顶层块**就能混过
 * 形状闸的「块数 ≥2 且有叶」这一关（下面那行 `请求超时: 请重试` 正是它凑出来的
 * 那一叶）。目录是「什么算档案叶」的唯一权威，而这两块整块都在目录外：
 * 目录对照体检的漂移叶口径只收「目录内块写出的目录外叶」，故这份夹具落在
 * 它的口径之外——即该形态当前无下游守卫（有意取舍，见形状闸旁的注）。
 */
const HOST_ERROR_MULTI_BLOCK_YAML = [
    '连接失败:',
    '  请求超时: 请重试',
    '请求地址:',
    '  https://api.example.com/v1/chat/completions',
].join('\n');

/**
 * 形态夹具八（叶层缩进基准）：同一块里叶缩进一深一浅，末叶还带一个更深的子键。
 * 基准取「块内首叶」而不取「上一个叶」——后者会把末叶（4 空格）吞进中叶（2 空格）
 * 的值里：既不进叶也不进未识别，静默全绿。第二块只为了让形状闸放行（顶层块 <2
 * 即 SINGLE_BLOCK），不参与本断言。
 */
const MIXED_INDENT_YAML = [
    '基本信息:',
    '    年龄: 三十四',
    '  性别: 男',
    '    身份: 夜校代课老师',
    '      来源: 街坊介绍',
    '外貌:',
    '  整体印象: 瘦高，肩线绷得很直',
].join('\n');

/**
 * 形态夹具九（裁决③）：生成契约点名的偷懒占位。两叶都写「待定」——不排除占位
 * 值的话它们就是一对「完全同值」，而它们承载的事实是「作者没写」而不是
 * 「同一件事写了两遍」。
 */
const PLACEHOLDER_VALUES_YAML = [
    '基本信息:',
    '  年龄: 三十四',
    '  身份: 待定',
    '恐惧软肋:',
    '  最深恐惧: 待定',
    '  软肋人或物: N/A',
].join('\n');

/**
 * 形态夹具十（裁决④）：裸列表项与无主续行——块下还没有叶可以并入时，这两行
 * 从前被静默丢弃。丢弃即看不见：未识别行是目录漂移的体检信号，丢了就只剩
 * 「看起来都认得了」。
 */
const ORPHAN_LINE_YAML = [
    '基本信息:',
    '  备注:',
    '    - 街坊介绍',
    '  年龄: 三十四',
    '  身份: 夜校代课老师',
    '既有关系:',
    '  - 妹妹',
    '    十五岁那年冬天',
].join('\n');

/**
 * 目录键集夹具：一个带条件叶的普通块。它证的是「目录认条件叶」这条规则本身，
 * 与策展目录的增删无关（模板叶块已随锚点目录退役）。
 */
const KEYSET_CATALOG: ReadonlyArray<CatalogBlock> = [
    {
        name: '性格',
        tier: 'common',
        leaves: [{ name: '核心矛盾', definition: '' }],
        optionalLeaf: { name: '类型学速记', definition: '' },
    },
];

/**
 * LITERAL_SAMPLE（人工构造）：两叶归一后完全同值。别名与名号那叶句尾是全角
 * 逗号、专属称谓那叶是半角逗号——原串不等，成不成立全看 PUNCTUATION_FOLD 有
 * 没有落到代码里，只比原串的话这对就不会被报出来。叶对取归属表第 2 对的两端
 * （通用叫法 × 专属叫法）：同一句话两端各写一遍，正是归属表要拦的那种换皮。
 */
const LITERAL_SAMPLE = [
    '基本信息:',
    '  年龄: 三十四',
    '  别名与名号: 街面上都叫他「阿槐」，',
    '既有关系:',
    '  专属称谓: 街面上都叫他「阿槐」,',
    '  相处基调: 泊位上的老默契，不用开口对眼神',
].join('\n');

/** LITERAL_SAMPLE 的反转版：两叶是近义改写而非同值，必须零命中（本层不判语义）。 */
const LITERAL_REVERSED_SAMPLE = [
    '基本信息:',
    '  年龄: 三十四',
    '  别名与名号: 街面上都叫他「阿槐」',
    '既有关系:',
    '  专属称谓: 码头上都喊他阿槐',
    '  相处基调: 泊位上的老默契，不用开口对眼神',
].join('\n');

/**
 * REDUNDANCY_SAMPLE（脱敏用户样本，块叶形态按锚点目录对齐；素材与提示词里
 * 那三组反例同源：替妹妹瞒着家里许人的事。假名「阿槐」是合成值，样本内无真实
 * 姓名）。
 *
 * 覆盖面：归属对第 1 对（底线雷区·绝不做的事 × 行为禁区）、第 2 对（既有关系·
 * 专属称谓 × 基本信息·别名与名号）、第 3 对（外貌·整体印象 × 辨识标记）两端
 * 都在场；第 4 对（目标动机）只有 深层需要 一端——外部义务 不在样本，该对在
 * 本样本上不构成任何 literal 断言。
 */
const REDUNDANCY_SAMPLE = [
    '基本信息:',
    '  身份定位: 夜校代课老师，白天在巷口小饭馆看后厨',
    '  别名与名号: 街面上都叫他「阿槐」，他从不纠正',
    '外貌:',
    '  整体印象: 瘦高，肩线绷得很直，说话前习惯先停半拍',
    '  辨识标记: 左手虎口一道旧疤，端盘子时格外显眼',
    '性格:',
    '  核心矛盾: 见不得人难堪／受不了被人当提款机',
    '言谈习惯:',
    '  口头禅与语气词: 到时候再说吧；句尾常挂一个「吧」',
    '  说话方式: 慢，说三句留半句给人接',
    '底线雷区:',
    '  绝不做的事: 绝不向外人道出妹妹被家里许人的事',
    '  行为禁区: 拿妹妹的名誉开玩笑、当众追问她的私事',
    '  禁触话题: 妹妹的婚约、家里的打算',
    '目标动机:',
    '  深层需要: 他受够了必须有用，要的是有人把他当人看',
    '既有关系:',
    '  专属称谓: 只在两人之间用的称呼——妹妹叫他「哥」，他回「小妹」',
].join('\n');

function runRedundancyChecks(): void {
    // 目录键集是解析层与判据层唯一的「什么算档案叶」权威（裁决②）：条件叶在清单
    // 里以【…】成文、在档案里以裸键出现，键名归一收在一处。任一处退回
    // `'name' in leaf` 或自剥方括号，这条断言立刻翻红。
    const keyset = catalogKeySet(KEYSET_CATALOG);
    check('目录键集：条件叶按裸键名入集（【】壳剥在 catalogKeyName 单点）',
        keyset.has('性格') && keyset.has('性格·核心矛盾') && keyset.has('性格·类型学速记')
        && catalogKeyName('【类型学速记】') === '类型学速记',
        `keys=${JSON.stringify([...keyset])}`);

    // 叶层缩进基准取块内首叶（裁决⑫）：三叶都取到，末叶带的那条更深的子键并进
    // 它的值而不是把它并进中叶。拿「上一个叶」当基准时，末叶会整个消失——
    // 既不进叶也不进未识别，静默全绿。
    const mixedScan = scanProfileLeaves(MIXED_INDENT_YAML);
    check('yaml 叶级：块内叶层缩进以块内首叶为基准（混合缩进·末叶不被并进中叶）',
        jsonEq(mixedScan.leaves.map(row => [row.block, row.leaf, row.value]),
            [['基本信息', '年龄', '三十四'], ['基本信息', '性别', '男'],
                ['基本信息', '身份', '夜校代课老师\n来源: 街坊介绍'], ['外貌', '整体印象', '瘦高，肩线绷得很直']])
        && jsonEq(mixedScan.leafKeys,
            ['基本信息·年龄', '基本信息·性别', '基本信息·身份', '外貌·整体印象']),
        `叶=${JSON.stringify(mixedScan.leaves.map(row => [row.block, row.leaf, row.value]))}`);

    // 加固①：列表承载叶与空值叶先排除。不排除时这四叶（年龄/性别/身份/爱好）
    // 取到的都是空串，两两互判即 6 对「完全同值」——期望值里的 form 序列同时
    // 证明这些空叶确实在场上、确实被判成了空值而不是没解析出来。
    const emptyScan = scanProfileLeaves(EMPTY_AND_LIST_LEAF_YAML);
    const emptyLeafForms = emptyScan.leaves.map(row => `${row.block}·${row.leaf}:${row.form}`);
    const emptyGroups = literalDuplicateSignatures(EMPTY_AND_LIST_LEAF_YAML);
    check('yaml 叶级＋判据：列表承载叶与空值叶先排除（加固①·不排除即 6 对假命中）',
        jsonEq(emptyLeafForms,
            ['基本信息·年龄:scalar', '基本信息·性别:scalar', '基本信息·身份:scalar', '喜恶·喜欢:list', '兴趣嗜好·爱好:scalar'])
        && emptyGroups.length === 0,
        `叶=${JSON.stringify(emptyLeafForms)} 同值组=${JSON.stringify(emptyGroups)}`);

    // 裁决③的占位那一类：两叶都写「待定」必须零对。占位词表取自
    // PROFILE_PLACEHOLDER_VALUES（由生成契约同一份词插值成文），判据层不另抄。
    const placeholderScan = scanProfileLeaves(PLACEHOLDER_VALUES_YAML);
    const placeholderRows = placeholderScan.leaves.filter(row => normalizeLeafValue(row.value) === '待定');
    const placeholderGroups = literalDuplicateSignatures(PLACEHOLDER_VALUES_YAML);
    check('判据：契约点名的偷懒占位不算「完全同值」（裁决③·两叶都写待定仍零对）',
        placeholderRows.length === 2 && placeholderRows.every(row => !isJudgeableLeaf(row))
        && PROFILE_PLACEHOLDER_VALUES.includes('待定') && PROFILE_PLACEHOLDER_VALUES.includes('N/A')
        && placeholderGroups.length === 0,
        `待定叶=${placeholderRows.length} 同值组=${JSON.stringify(placeholderGroups)}`);

    // 加固②：块首行内联的首叶。只认缩进的读法在这份夹具上只能解析出 2 叶，
    // 期望值写的是 3 叶——差的那一叶就是首叶。
    const inlineScan = scanProfileLeaves(INLINE_FIRST_LEAF_YAML);
    check('yaml 叶级：块首行内联的首叶不被丢（加固②·只认缩进则首叶消失）',
        jsonEq(inlineScan.leaves.map(row => [row.block, row.leaf, row.value]),
            [['基本信息', '年龄', '三十四'], ['基本信息', '性别', '男'], ['外貌', '整体印象', '瘦高，肩线绷得很直']]),
        `叶=${JSON.stringify(inlineScan.leaves.map(row => `${row.block}·${row.leaf}`))}`);

    // 加固③：1 空格缩进的叶仍算叶。
    const oneSpaceScan = scanProfileLeaves(ONE_SPACE_INDENT_YAML);
    const oneSpaceBlocks = parseYamlToBlocks(ONE_SPACE_INDENT_YAML);
    check('yaml 叶级：1 空格缩进的叶仍算叶（加固③·反向用例见下一条）',
        jsonEq(oneSpaceScan.blocks, ['基本信息', '外貌'])
        && jsonEq(oneSpaceScan.leaves.map(row => [row.block, row.leaf]),
            [['基本信息', '年龄'], ['基本信息', '性别'], ['外貌', '整体印象']]),
        `块=${JSON.stringify(oneSpaceScan.blocks)} 叶=${JSON.stringify(oneSpaceScan.leaves.map(row => `${row.block}·${row.leaf}`))}`);
    // 加固③的反向用例：同一份文本走切块口径（缩进 ≤1 算块界），两个块的值都成
    // 了空串——叶被读成顶层块、整块零叶，而零叶的报告与「确实没重复」不可区分。
    check('yaml 叶级：加固③反向用例（切块口径下 1 空格叶被当顶层块·两块零叶）',
        oneSpaceBlocks.get('基本信息') === '' && oneSpaceBlocks.get('外貌') === '',
        `keys=${[...oneSpaceBlocks.keys()].join('/')}`);

    // 加固④：顶层块 <2 报 SINGLE_BLOCK，形状闸拒判这份文本。反向用例同在：
    // 这份文本会踩单顶层键的整块去缩进分支，顶层键被丢掉。
    const singleShape = checkProfileShape(SINGLE_BLOCK_YAML);
    check('yaml 形状：单块档案报 SINGLE_BLOCK 且拒判（加固④）',
        !singleShape.ok && singleShape.code === 'SINGLE_BLOCK'
        && singleShape.topLevelBlocks === 1 && singleShape.leafCount === 2
        && ![...parseYamlToBlocks(SINGLE_BLOCK_YAML).keys()].includes('基本信息'),
        `shape=${JSON.stringify(singleShape)}`);

    // 加固⑤：机制挂载块的原生叫法不再整行被当块内容丢掉。两个未识别计数分开取：
    // 「整块在目录外」（机制挂载块，永远不必补叶）与「目录里这块有、模型多写了
    // 一叶」（要查）是两类处置，合进一个计数就分不出来了。
    const mechScan = scanProfileLeaves(MECHANISM_NAMED_YAML);
    const mechDrift = analyzeCatalogDrift(MECHANISM_NAMED_YAML, FIXTURE_CATALOG);
    check('yaml 叶级＋目录对照：机制挂载块的原生叫法不再整行丢弃（加固⑤·未识别块/叶分开计）',
        jsonEq(mechScan.blocks, ['基本信息', '底牌机制'])
        && jsonEq(mechScan.leaves.map(row => [row.block, row.leaf]),
            [['基本信息', '年龄'], ['底牌机制', 'HP 成长'], ['底牌机制', '冷却-判定']])
        && mechDrift.mechanismBlocksOutsideCatalog === 1
        && mechDrift.unrecognizedLeavesTotal === 2,
        `块=${JSON.stringify(mechScan.blocks)} 未识别块=${mechDrift.mechanismBlocksOutsideCatalog} 未识别叶=${mechDrift.unrecognizedLeavesTotal}`);

    // 裁决④：块下还没有叶可并时，裸列表项与缩进散文都不再静默丢弃——它们连同
    // 目录外的那一叶（备注）一起进未识别叶，两个未识别计数各归其位（两个块名本身
    // 都在目录里，所以未识别块为空——这一条同时钉住「未识别块」只装整块在目录外的）。
    const orphanScan = scanProfileLeaves(ORPHAN_LINE_YAML);
    const orphanDrift = analyzeCatalogDrift(ORPHAN_LINE_YAML, FIXTURE_CATALOG);
    check('yaml 叶级＋目录对照：裸列表项与无主续行进无主行、不再静默丢弃（裁决④）',
        jsonEq(orphanScan.leafKeys, ['基本信息·备注', '基本信息·年龄', '基本信息·身份'])
        && jsonEq(orphanScan.orphanLines, ['- 妹妹', '十五岁那年冬天'])
        && orphanDrift.mechanismBlocksOutsideCatalog === 0
        && orphanDrift.unrecognizedLeavesTotal === 3,
        `叶键=${JSON.stringify(orphanScan.leafKeys)} 无主行=${JSON.stringify(orphanScan.orphanLines)} 未识别块=${orphanDrift.mechanismBlocksOutsideCatalog} 未识别叶=${orphanDrift.unrecognizedLeavesTotal}`);

    // catalogDriftLeaves＝「目录里这块有、模型多写了一叶」，是审稿轮收尾那条
    // 目录漂移 warn 的触发口径。差集两头各钉一条：机制挂载块的叶**不进**（口径
    // 若含它，每份挂机制块的正常档案都喊漂移，告警随即失效）；目录内块多写的
    // 叶**进**，而无主行不算（它不是某个叶的漂移，是模型手滑）。
    check('yaml 判据：catalogDriftLeaves 只装「目录内块里写出的目录外叶」（机制挂载块的叶与无主行都不算）',
        jsonEq(mechDrift.catalogDriftLeaves, [])
        && jsonEq(orphanDrift.catalogDriftLeaves, ['基本信息·备注']),
        `机制挂载块那份=${JSON.stringify(mechDrift.catalogDriftLeaves)} 无主行那份=${JSON.stringify(orphanDrift.catalogDriftLeaves)}`);

    // 加固⑥：档案段此前从不跑形状校验。宿主错误正文在这里落成零叶——它有 2 个
    // 顶层「块」，只靠「块数 ≥2」放行等于没校验。
    const envelopeShape = checkProfileShape(HOST_ERROR_ENVELOPE_YAML);
    check('yaml 形状：宿主错误正文报 NO_LEAVES（加固⑥）',
        !envelopeShape.ok && envelopeShape.code === 'NO_LEAVES' && envelopeShape.leafCount === 0,
        `shape=${JSON.stringify(envelopeShape)}`);

    // 裁决⑬：形状闸只看得见块数与叶数，宿主错误正文凑够两个顶层块就能混过去。
    // 这一条钉住那个洞本身——**该形态现无守卫**：形状闸放行，目录对照体检的
    // catalogDriftLeaves 只收目录内块里写出的目录外叶，错误正文的两块整块在
    // 目录外、口径之外恒不触发（下一条把这条边界钉成机判）。语义查重判据面随
    // 死码退役是有意决策，形状层不因此自行加码。
    const multiShape = checkProfileShape(HOST_ERROR_MULTI_BLOCK_YAML);
    check('yaml 形状：错误正文凑够两块时形状闸放行（裁决⑬·该形态现无下游守卫）',
        multiShape.ok && multiShape.topLevelBlocks === 2 && multiShape.leafCount === 1,
        `shape=${JSON.stringify(multiShape)}`);

    // 反向钉边界：上一条的洞不是「断言缺失」，目录对照体检在这份错误正文上
    // 恒零命中是口径使然（两块整块在目录外，不属 catalogDriftLeaves 的
    // 「目录内块写出的目录外叶」）。写成机判是为了让后来人不再把它当漏报去补。
    const multiShapeDrift = analyzeCatalogDrift(HOST_ERROR_MULTI_BLOCK_YAML, FIXTURE_CATALOG);
    check('yaml 判据：错误正文（整块目录外）恒不进 catalogDriftLeaves——目录体检只收目录内块的越界叶，故该形态无下游守卫（非漏报）',
        jsonEq(multiShapeDrift.catalogDriftLeaves, []) && multiShapeDrift.mechanismBlocksOutsideCatalog === 2,
        `漂移叶=${JSON.stringify(multiShapeDrift.catalogDriftLeaves)} 目录外块=${multiShapeDrift.mechanismBlocksOutsideCatalog}`);

    const sampleShape = checkProfileShape(REDUNDANCY_SAMPLE);
    check('yaml 形状：填好的档案形状校验放行（加固⑥的放行侧）',
        sampleShape.ok && sampleShape.code === null
        && sampleShape.topLevelBlocks === 7 && sampleShape.leafCount === 12,
        `shape=${JSON.stringify(sampleShape)}`);

    // LITERAL_SAMPLE：归一后完全同值必命中（别名与名号那叶句尾是全角逗号、
    // 专属称谓那叶是半角逗号——这一对正是「靠标点表才成立」的用例：两边都折成
    // 半角才同值）。
    const literalGroups = literalDuplicateSignatures(LITERAL_SAMPLE);
    check('判据：LITERAL_SAMPLE 必命中（归一后完全同值·含靠标点表才成立的一对）',
        jsonEq(literalGroups, ['基本信息·别名与名号|既有关系·专属称谓']),
        `同值组=${JSON.stringify(literalGroups)}`);
    // 反转版必零命中：近义改写不由本层判定（判据的语义检出率为零，这是既定边界）。
    const reversedGroups = literalDuplicateSignatures(LITERAL_REVERSED_SAMPLE);
    check('判据：LITERAL_SAMPLE 反转版必零命中（近义改写不由本层判定）',
        reversedGroups.length === 0,
        `同值组=${JSON.stringify(reversedGroups)}`);

    // REDUNDANCY_SAMPLE：该样本上 literal 零命中是**预期**——三组反例里那些「同一份
    // 素材被写重」的叶用的都是同义改写，本层按定义抓不到。断言写成「必须零命中」
    // ——写成「应当命中」等于把砍判据这件事做回来。
    const sampleGroups = literalDuplicateSignatures(REDUNDANCY_SAMPLE);
    check('判据：REDUNDANCY_SAMPLE 的 literal 零命中是预期（语义重复不由本层判定·不是漏报）',
        sampleGroups.length === 0,
        `同值组=${JSON.stringify(sampleGroups)}`);
    const sampleDrift = analyzeCatalogDrift(REDUNDANCY_SAMPLE, FIXTURE_CATALOG);
    const defaultCatalogDrift = analyzeCatalogDrift(REDUNDANCY_SAMPLE);
    check('判据：REDUNDANCY_SAMPLE 未识别块/叶 0（内联目录与默认目录下各跑一次·叶名未漂移）',
        sampleDrift.mechanismBlocksOutsideCatalog === 0 && sampleDrift.unrecognizedLeavesTotal === 0
        && defaultCatalogDrift.mechanismBlocksOutsideCatalog === 0 && defaultCatalogDrift.unrecognizedLeavesTotal === 0,
        `内联目录=块${sampleDrift.mechanismBlocksOutsideCatalog}／叶${sampleDrift.unrecognizedLeavesTotal}`
        + ` 默认目录=块${defaultCatalogDrift.mechanismBlocksOutsideCatalog}／叶${defaultCatalogDrift.unrecognizedLeavesTotal}`);

    // 归一规则机判（上半段）：NFKC 折全角拉丁与**全角标点**、连续空白（含全角
    // 空格）折成一个半角空格——所以 `，`／`：／`；／`？／`!／`（）` 这些在
    // PUNCTUATION_FOLD 里不许留条目（NFKC 已经折了，留着即不可达的死配置）。
    // 另钉死两条**不做**的猜测：大小写不折叠（`MBTI` 与 `mbti` 不是一个事实），
    // 句尾标点也不剔除（`不喝酒，` 与 `不喝酒` 是两个值，剔除尾部标点靠猜）。
    check('判据：归一规则机判·NFKC 与空白段（大小写与句尾标点不折叠）',
        normalizeLeafValue('Ａｇｅ') === 'Age'
        && normalizeLeafValue('夜校，') === '夜校,'
        && isSameLeafValue('夜校　代课老师', '夜校 代课老师')
        && !isSameLeafValue('不喝酒，', '不喝酒')
        && !isSameLeafValue('MBTI', 'mbti'),
        `Age=${normalizeLeafValue('Ａｇｅ')} 全角逗号=${normalizeLeafValue('夜校，')} 全角空格=${normalizeLeafValue('夜校　代课老师')}`);

    // 归一规则机判（下半段）：PUNCTUATION_FOLD 里每一个字符各配一条断言，且这
    // 三条**只有表能成立**——NFKC 都不碰它们（`“”《》—` 的半角形都不是它们），
    // 把哪一条从表里删掉，对应的那一条立刻翻红。表里新增字符照此补一条。
    check('判据：PUNCTUATION_FOLD 表内字符逐条机判（每条只有标点表能成立·NFKC 不碰它们）',
        isSameLeafValue('他说“好”', '他说"好"')
        && isSameLeafValue('《夜校代课》', '<夜校代课>')
        && normalizeLeafValue('HP—成长') === 'HP-成长',
        `引号=${normalizeLeafValue('他说“好”')} 书名号=${normalizeLeafValue('《夜校代课》')} 破折号=${normalizeLeafValue('HP—成长')}`);
}

// ---------------------------------------------------------------------------
// 5) 统一 api 客户端请求体形状（fetch 桩）
// ---------------------------------------------------------------------------

function fakeSSEStream(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const queue = chunks.map(c => encoder.encode(c));
    return {
        ok: true,
        status: 200,
        body: {
            // 与宿主同构：ReadableStreamDefaultReader 带 cancel（被放弃的流由
            // 传输层显式关闭）——桩缺 cancel 会让那条路径在桩上抛 TypeError
            // 并盖掉原始错误，缺陷与误报两个方向都测不到
            getReader: () => ({
                read: async () => queue.length > 0 ? { done: false, value: queue.shift() } : { done: true },
                cancel: async () => undefined,
            }),
        },
    } as unknown as Response;
}

/**
 * persona 链的超时/取消分流（真跑 runGeneration：嵌套在引擎组装→传输→归类
 * 三层之下，choice 那五条只测得到 choice 的直连路径，测不到这里的嵌套面）。
 *
 * 不真等 600 秒：把 setTimeout 换成记录延时的桩，命中该延时就改为手动触发
 * （①立即触发、③在取消之后触发），「到点中止」因此同步可测。fetch 桩照真实
 * fetch 的中止语义——收到 abort（或进场时已中止）即以 AbortError 拒绝；不这样
 * 桩就测不出到点中止的后果，死端点恰恰就是这个样子。
 *
 * 桩只认**第一个** 600 秒定时器（后续同延时的照常记录但不再触发）：真实时间轴上
 * 谁先创建谁先到点，而「同一档位的第二个守卫」正是要防的形态——第二个到点时
 * 传输层自认不是自己到点，人话超时被换成裸 abort。桩把每个都立刻触发的话，
 * 这个形态会被桩自己掩盖掉（本条即这么翻红过一次：全触发→绿，首个触发→红）。
 */
async function runGenerationTimeoutChecks(): Promise<void> {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    let fetchEntered = false;
    const hangingFetch = (): typeof fetch => (async (_url: string | URL, init?: RequestInit) => {
        fetchEntered = true;
        return new Promise<Response>((_resolve, reject) => {
            const abortLike = (): void => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
            if (init?.signal?.aborted) abortLike();
            else init?.signal?.addEventListener('abort', abortLike);
        });
    }) as unknown as typeof fetch;
    const run = (request: string, signal?: AbortSignal): Promise<GenerationResult> => runGeneration({
        route: { providerId: 'smoke-endpoint', identity: { kind: 'provider', url: 'https://smoke.example.com/v1', key: 'sk-smoke' }, model: 'smoke-model', temperature: 1, reasoningEffort: 'high', noPrefill: false },
        request,
        wiText: '',
        greetingsText: '',
        onPrefillUnsupported: () => undefined,
        signal,
    });
    const caught = async (p: Promise<GenerationResult>): Promise<unknown> => {
        try {
            await p;
            return null;
        } catch (err) {
            return err;
        }
    };
    const runlog = useRunlogStore();
    try {
        // ①到点：传输层守卫按 persona 档位装 600 秒，到点中止并转成人话超时错误
        const delays: number[] = [];
        let firedOnce = false;
        globalThis.fetch = hangingFetch();
        globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
            if (Number(delay) === TASK_PARAMS.persona.timeoutSec * 1000) {
                delays.push(Number(delay));
                if (!firedOnce) {
                    firedOnce = true;
                    handler(...rest);
                }
                return 0;
            }
            return originalSetTimeout(handler, delay, ...rest);
        }) as unknown as typeof setTimeout;
        runlog.clear();
        const timeoutErr = await caught(run('超时试验'));
        const timeoutRecord = runlog.records[runlog.records.length - 1];
        check('生成超时：persona 请求装的是 600 秒上限（定时器延时机判——不是别的数，也不是不装），到点按失败可见报出人话超时',
            TASK_PARAMS.persona.timeoutSec === 600 && delays.includes(600_000)
            && !(timeoutErr instanceof PersonaRunCancelled)
            && (timeoutErr as Error)?.message.includes('请求超时（600 秒）')
            && !((timeoutErr as Error)?.message ?? '').includes('aborted')
            && !!timeoutRecord && timeoutRecord.ok === false && (timeoutRecord.error ?? '').includes('请求超时'),
            `timeoutSec=${TASK_PARAMS.persona.timeoutSec} delays=${JSON.stringify(delays)} thrown=${(timeoutErr as Error)?.name}:${((timeoutErr as Error)?.message ?? '').slice(0, 60)} runlog=${timeoutRecord?.error ?? '无'}`);

        // ②外部取消：真实定时器，只等请求发出再取消（请求中 abort→归类才是主战场）
        globalThis.setTimeout = originalSetTimeout;
        fetchEntered = false;
        globalThis.fetch = hangingFetch();
        const cancelCtrl = new AbortController();
        const cancelled = run('取消试验', cancelCtrl.signal);
        for (let i = 0; i < 100 && !fetchEntered; i++) await new Promise(r => originalSetTimeout(r, 5));
        cancelCtrl.abort();
        const cancelErr = await caught(cancelled);
        check('生成取消：外部取消归 PersonaRunCancelled（超时与取消两个语义分流未混走；用户侧提示为「已取消生成」）',
            cancelErr instanceof PersonaRunCancelled
            && TEXT.TOAST_CANCELLED === '已取消生成',
            `thrown=${(cancelErr as Error)?.name}:${(cancelErr as Error)?.message}`);

        // ③竞态：取消先到、到点随后（同一请求窗口内）——到点已成立时不得被改写成
        // 「已取消」。这条专门钉传输层的超时判定优先级：只把 ② 钉住的话，
        // 「aborted 就报已取消」的写法照样全绿，而真实端点上用户会在毫秒内先看到
        // 一句「已取消」——他没按过任何东西。
        let fireTimeout = (): void => undefined;
        let capturedOnce = false;
        globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
            if (Number(delay) === TASK_PARAMS.persona.timeoutSec * 1000) {
                if (!capturedOnce) {
                    capturedOnce = true;
                    fireTimeout = () => handler(...rest);
                }
                return 0;
            }
            return originalSetTimeout(handler, delay, ...rest);
        }) as unknown as typeof setTimeout;
        fetchEntered = false;
        globalThis.fetch = hangingFetch();
        const raceCtrl = new AbortController();
        const racing = run('竞态试验', raceCtrl.signal);
        for (let i = 0; i < 100 && !fetchEntered; i++) await new Promise(r => originalSetTimeout(r, 5));
        // 取消与到点在同一同步块内先后触发：到点的 timedOut 标志必须在中止
        // 拒绝被归类之前立起来（拒绝是微任务，同步块内不会插进来）。
        raceCtrl.abort();
        fireTimeout();
        const raceErr = await caught(racing);
        check('生成超时：取消与到点竞态（取消先到、到点随后）仍按超时报，不被改写成「已取消」',
            !(raceErr instanceof PersonaRunCancelled)
            && (raceErr as Error)?.message.includes('请求超时（600 秒）'),
            `thrown=${(raceErr as Error)?.name}:${(raceErr as Error)?.message}`);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalSetTimeout;
    }
}

async function runApiChecks(): Promise<void> {
    // 纯函数：端点规范化
    check('api：normalizeApiBase 剥尾斜杠+/chat/completions（保留 /v1）',
        normalizeApiBase('https://api.example.com/v1/chat/completions/') === 'https://api.example.com/v1'
        && normalizeApiBase('https://api.example.com') === 'https://api.example.com');
    check('api：normalizeApiUrl 四步（剥 /chat/completions、裸域名补 /v1、剥尾斜杠）',
        normalizeApiUrl('https://api.example.com/v1/chat/completions') === 'https://api.example.com/v1'
        && normalizeApiUrl('https://api.example.com') === 'https://api.example.com/v1'
        && normalizeApiUrl('https://api.example.com/v1/') === 'https://api.example.com/v1');

    // 纯函数：请求体形状（缺省任务参数不进请求体——显式发送制）
    const body = buildGenerateBody(
        [{ role: 'user', content: 'hi' }],
        { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-test' }, model: 'm1', stream: false, outputContract: 'prompt_only', reasoningEffort: 'off', timeoutSec: TASK_PARAMS.persona.timeoutSec },
    );
    check('api：buildGenerateBody 基础形状（quiet/custom/reverse_proxy/proxy_password/tool_choice；缺省温度与 max_tokens 不发）',
        body.type === 'quiet' && body.chat_completion_source === 'custom'
        && body.reverse_proxy === 'https://api.example.com/v1' && body.proxy_password === 'sk-test'
        && body.model === 'm1' && Array.isArray(body.messages) && body.tool_choice === 'none'
        && body.stream === false
        && !('temperature' in body) && !('max_tokens' in body) && !('reasoning_effort' in body)
        && !('response_format' in body) && !('json_schema' in body));
    const bodyExplicit = buildGenerateBody(
        [{ role: 'user', content: 'hi' }],
        { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-test' }, model: 'm1', stream: true, outputContract: 'prompt_only', temperature: 0.5, timeoutSec: TASK_PARAMS.persona.timeoutSec },
    );
    check('api：buildGenerateBody 显式参数（temperature 进请求体、stream 恒发）',
        bodyExplicit.temperature === 0.5 && bodyExplicit.stream === true && !('max_tokens' in bodyExplicit));

    // 输出契约两档（json_schema 档已随生成通道收敛退役——choice 恒 json_object，
    // 宿主透传 response_format；prompt_only 不发契约键）
    const bodyJsonObject = buildGenerateBody(
        [{ role: 'user', content: 'hi' }],
        { task: 'persona', identity: { kind: 'provider', url: 'https://a.example.com', key: 'k' }, model: 'm', stream: false, outputContract: 'json_object', timeoutSec: TASK_PARAMS.persona.timeoutSec },
    );
    check('api：输出契约两档（json_object→response_format；prompt_only 无契约键）',
        (bodyJsonObject.response_format as Record<string, unknown> | undefined)?.type === 'json_object'
        && !('json_schema' in bodyJsonObject));

    // 破限预设解析（宿主桩「冒烟破限」）：启用文本条目按原角色原顺序，
    // marker 占位与停用条目剔除
    const jbEntries = readPresetInjectMessages('冒烟破限');
    check('api：破限预设解析（启用文本条目角色保真，marker/停用剔除）',
        jbEntries !== null && jbEntries.length === 2
        && jbEntries[0].role === 'assistant' && jbEntries[0].content === '破限开场白'
        && jbEntries[1].role === 'user' && jbEntries[1].content === '破限接话',
        `jb=${JSON.stringify(jbEntries)}`);
    check('api：破限预设悬空名返回 null（fail-soft 判据）', readPresetInjectMessages('不存在预设') === null);

    // stub 同构机判：管理器经 getPresetManager('openai') 取得实例——双方法
    // 在同一实例上，且 getCompletionPresetByName 保留接收者调用返回的预设
    // 与 this.getPresetList() 清单里的对象同一（内部 this 互调链成立的
    // 结构判据；stub 若退化成箭头函数/解引用调用，此断言翻红）
    const pm = getTavernContext()?.getPresetManager?.('openai');
    const pmRec = pm && typeof pm === 'object' ? (pm as unknown as Record<string, unknown>) : null;
    const pmList = pmRec && typeof pmRec.getPresetList === 'function'
        ? (pmRec.getPresetList as (api: string) => { presets: unknown[]; preset_names: Record<string, number> })('openai')
        : null;
    const pmPreset = pmRec && typeof pmRec.getCompletionPresetByName === 'function'
        ? (pmRec.getCompletionPresetByName as (name: string) => unknown)('冒烟破限')
        : undefined;
    check('api：破限管理器 stub 同构（同一实例双方法，this 内部互调成立）',
        pmRec !== null
        && typeof pmRec.getCompletionPresetByName === 'function'
        && typeof pmRec.getPresetList === 'function'
        && pmList !== null && Array.isArray(pmList.presets)
        && pmPreset !== undefined && pmPreset === pmList.presets[pmList.preset_names['冒烟破限']],
        `pm=${JSON.stringify(pmPreset)} / list=${JSON.stringify(pmList)}`);
    check('api：破限管理器保留接收者按名取预设（解引用丢 this 在此翻红）',
        pmPreset !== null && typeof pmPreset === 'object'
        && Array.isArray((pmPreset as { prompts?: unknown[] }).prompts)
        && (pmPreset as { prompts: unknown[] }).prompts.length === 4);

    // reasoning_effort 纪律（off 不发已在基础形状断言——这里断言 high 发）
    const bodyEffort = buildGenerateBody(
        [{ role: 'user', content: 'hi' }],
        { task: 'persona', identity: { kind: 'provider', url: 'https://a.example.com', key: 'k' }, model: 'm', stream: false, outputContract: 'prompt_only', reasoningEffort: 'high', timeoutSec: TASK_PARAMS.persona.timeoutSec },
    );
    check('api：reasoning_effort＝high 注入（low/medium/high 档）', bodyEffort.reasoning_effort === 'high');

    // SSE 帧状态机（经 callGenerateEndpoint 公共面）
    const originalFetch = globalThis.fetch;
    const sseCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        sseCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
        return fakeSSEStream(['data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: [DONE]\n\n']);
    }) as typeof fetch;
    try {
        const r1 = await callGenerateEndpoint(
            [{ role: 'user', content: 'hi' }],
            { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-t' }, model: 'm1', stream: true, outputContract: 'prompt_only', timeoutSec: TASK_PARAMS.persona.timeoutSec },
        );
        check('api：流式 SSE 帧状态机（\\n\\n 分帧、[DONE] 跳过、delta 拼接、走宿主路由）',
            r1.streamed && r1.content === '你' && sseCalls[0]?.url === '/api/backends/chat-completions/generate',
            `text=${r1.content}`);
        globalThis.fetch = (async () => fakeSSEStream(['data: {"choices":[{"delta":{"content":"甲"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"乙"}}]}'])) as typeof fetch;
        const r2 = await callGenerateEndpoint(
            [{ role: 'user', content: 'hi' }],
            { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-t' }, model: 'm1', stream: true, outputContract: 'prompt_only', timeoutSec: TASK_PARAMS.persona.timeoutSec },
        );
        check('api：流式 \\r\\n 归一＋尾帧无终止符补消费', r2.content === '甲乙', `text=${r2.content}`);

        // 截断显式报错回归：finish_reason=length 的流不得静默成功——报错指名
        // 真因（推理模型思维链吃预算把正文掐断的实测形态），且记录保留半截正文
        globalThis.fetch = (async () => fakeSSEStream([
            'data: {"choices":[{"delta":{"content":"{\\"options\\": ["}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"甲\\""}}]}\n\n',
            'data: {"choices":[{"delta":{"content":""},"finish_reason":"length"}]}\n\n',
            'data: [DONE]\n\n',
        ])) as typeof fetch;
        let truncationThrown = '';
        try {
            await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-t' }, model: 'm1', stream: true, outputContract: 'prompt_only', timeoutSec: TASK_PARAMS.persona.timeoutSec },
            );
        } catch (e) {
            truncationThrown = (e as Error).message;
        }
        const truncationRecord = useRunlogStore().records[useRunlogStore().records.length - 1];
        check('api：finish_reason=length 截断显式报错（指名 token 上限真因＋记录保留半截正文，不伪装成解析失败）',
            truncationThrown.includes('输出被截断') && truncationThrown.includes('token 上限')
            && !!truncationRecord && truncationRecord.ok === false
            && truncationRecord.responseText.includes('"title":"甲"') && (truncationRecord.error ?? '').includes('输出被截断'),
            `thrown=${truncationThrown.slice(0, 60)}`);
    } finally {
        globalThis.fetch = originalFetch;
    }

    // 非流式：content 读取 + json.error 抛错
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '好的' } }] }) })) as unknown as typeof fetch;
    try {
        const r3 = await callGenerateEndpoint(
            [{ role: 'user', content: 'hi' }],
            { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-t' }, model: 'm1', stream: false, outputContract: 'prompt_only', timeoutSec: TASK_PARAMS.persona.timeoutSec },
        );
        check('api：非流式 content 读取（choices[0].message.content）', !r3.streamed && r3.content === '好的');
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ error: { message: 'quota exceeded' } }) })) as unknown as typeof fetch;
        let errorThrown = false;
        try {
            await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-t' }, model: 'm1', stream: false, outputContract: 'prompt_only', timeoutSec: TASK_PARAMS.persona.timeoutSec },
            );
        } catch (e) {
            errorThrown = (e as Error).message.includes('quota');
        }
        check('api：非流式 json.error 抛错（含上游错误信息）', errorThrown);

        // 宿主错误信封：生成失败被宿主包装成 **HTTP 200 + 正常响应壳**
        // （流式补一帧带 `tauritavern-error-chunk-` 前缀 id 的错误帧；
        // 非流式回 `tauritavern-error-` 前缀 id 的 chat.completion）。
        // 不认信封 id，错误正文就会冒充模型产出返回上层——实测事故：整段
        // 错误文本被当成策展 schema 送进人设第二段、prefill 首键派生成
        // 「连接目标服务失败:」。判据只认 id 前缀（不看正文标签）。
        const HOST_ERROR_BODY = '[API 错误]\n连接目标服务失败：当前网络、VPN、代理或接口地址可能暂时不可用。';
        globalThis.fetch = (async () => fakeSSEStream([
            `data: ${JSON.stringify({ id: 'tauritavern-error-chunk-1791461520', choices: [{ delta: { content: HOST_ERROR_BODY } }] })}\n\n`,
            'data: [DONE]\n\n',
        ])) as typeof fetch;
        let streamEnvelopeThrown = '';
        try {
            await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-t' }, model: 'm1', stream: true, outputContract: 'prompt_only', timeoutSec: TASK_PARAMS.persona.timeoutSec },
            );
        } catch (e) {
            streamEnvelopeThrown = (e as Error).message;
        }
        const streamEnvelopeRecord = useRunlogStore().records[useRunlogStore().records.length - 1];
        check('api：流式宿主错误信封抛错（id 前缀判别、错误正文不冒充产出、runlog 记失败）',
            streamEnvelopeThrown.includes('连接目标服务失败')
            && !!streamEnvelopeRecord && streamEnvelopeRecord.ok === false
            && (streamEnvelopeRecord.error ?? '').includes('连接目标服务失败'),
            `thrown=${streamEnvelopeThrown.slice(0, 40)}`);

        globalThis.fetch = (async () => ({
            ok: true, status: 200,
            json: async () => ({ id: 'tauritavern-error-1791461520', choices: [{ message: { content: HOST_ERROR_BODY }, finish_reason: 'stop' }] }),
        })) as unknown as typeof fetch;
        let plainEnvelopeThrown = '';
        try {
            await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-t' }, model: 'm1', stream: false, outputContract: 'prompt_only', timeoutSec: TASK_PARAMS.persona.timeoutSec },
            );
        } catch (e) {
            plainEnvelopeThrown = (e as Error).message;
        }
        check('api：非流式宿主错误信封抛错（id 前缀判别）',
            plainEnvelopeThrown.includes('连接目标服务失败'), `thrown=${plainEnvelopeThrown.slice(0, 40)}`);

        // 反向守门：判据只认信封 id——正常产出即使正文恰好以错误标签开头
        // 也必须照常收下（文本判别会在这里误杀）。
        globalThis.fetch = (async () => fakeSSEStream([
            `data: ${JSON.stringify({ id: 'chatcmpl-normal-1', choices: [{ delta: { content: '[API Error]\n这是我写的示例文本' } }] })}\n\n`,
            'data: [DONE]\n\n',
        ])) as typeof fetch;
        let labelLookalike = '';
        try {
            const r = await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-t' }, model: 'm1', stream: true, outputContract: 'prompt_only', timeoutSec: TASK_PARAMS.persona.timeoutSec },
            );
            labelLookalike = r.content;
        } catch {
            labelLookalike = '(误抛)';
        }
        check('api：正常产出正文以错误标签开头不被误杀（判据只认信封 id、不看正文文本）',
            labelLookalike.includes('这是我写的示例文本'), `content=${labelLookalike.slice(0, 30)}`);

        // 流内上游错误帧（真实事故帧样本，抄自 llm-api-3158.response.sse 第 2 行
        // ——原文随宿主日志轮转清除、事后追不回，故进夹具）：流已开后上游 400
        // 被宿主原样转发，无信封 id、无 choices。不认它＝失败被记成 ok 空响应。
        globalThis.fetch = (async () => fakeSSEStream([
            `data: {"error":{"message":"upstream status 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"Requests ending with a model turn are not supported.\\",\\"status\\":\\"INVALID_ARGUMENT\\"}}","type":"invalid_request_error","param":null,"code":"invalid_argument"}}\n\n`,
        ])) as unknown as typeof fetch;
        let upstreamFrameThrown = '';
        try {
            await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-t' }, model: 'm1', stream: true, outputContract: 'prompt_only', timeoutSec: TASK_PARAMS.persona.timeoutSec },
            );
        } catch (e) {
            upstreamFrameThrown = (e as Error).message;
        }
        const upstreamFrameRecord = useRunlogStore().records[useRunlogStore().records.length - 1];
        check('api：流内上游错误帧抛错（error 对象判别、文案保留上游原文、runlog 记失败不再伪装 ok 空响应）',
            upstreamFrameThrown.includes('Requests ending with a model turn are not supported.')
            && upstreamFrameThrown.includes('upstream status 400')
            && !!upstreamFrameRecord && upstreamFrameRecord.ok === false
            && (upstreamFrameRecord.error ?? '').includes('Requests ending with a model turn'),
            `thrown=${upstreamFrameThrown.slice(0, 60)}`);

        // 反向守门：部分上游的正常帧带 error:null 键——null 不算错误帧，照常收下
        globalThis.fetch = (async () => fakeSSEStream([
            'data: {"error":null,"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n',
        ])) as unknown as typeof fetch;
        const rErrorNull = await callGenerateEndpoint(
            [{ role: 'user', content: 'hi' }],
            { task: 'persona', identity: { kind: 'provider', url: 'https://api.example.com/v1', key: 'sk-t' }, model: 'm1', stream: true, outputContract: 'prompt_only', timeoutSec: TASK_PARAMS.persona.timeoutSec },
        );
        check('api：正常帧带 error:null 不误杀（null 键照常收下 delta）', rErrorNull.content === '好', `text=${rErrorNull.content}`);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

// ---------------------------------------------------------------------------
// 6) persona 端到端（统一端点三段链：curator→personaGen→审稿，都走引擎管线；
//    审稿回合本身的探针在 7) 段，这里钉的是前两段与整链的面）
// ---------------------------------------------------------------------------

async function runPersonaE2EChecks(): Promise<void> {
    const store = usePersonaStore();
    // 服务商表放一个冒烟服务商，各任务行全部指向它
    writeApiDomain([{ id: 'smoke-endpoint', name: '冒烟服务商', url: 'https://smoke.example.com/v1', key: 'sk-smoke', models: ['smoke-model'], noPrefill: false }]);
    seedTaskProfiles('smoke-endpoint', 'smoke-model');
    store.requestText = '生成一个侦探人设';
    store.isProcessing = false;

    const CURATOR_YAML = '```yaml\n基本信息:\n姓名:\n年龄:\n```';
    const PERSONA_YAML = '```yaml\n姓名: 阿德\n年龄: 20\n```';
    const REVIEW_NO_REVISION = '无需修改';
    const calls: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    // 段→回执派发表。认不出段就抛（不猜）：猜出来的段会把某一段的 YAML
    // 喂给另一段的解析器，冒烟反而全绿
    const replyForStage = (body: CapturedRequest['body']): string => {
        const stage = stageOfRequest(body);
        if (stage === 'curator') return CURATOR_YAML;
        if (stage === 'personaGen') return PERSONA_YAML;
        if (stage === 'personaReview') return REVIEW_NO_REVISION;
        throw new Error(`冒烟桩认不出请求段：${JSON.stringify(body.messages.slice(-1))}`);
    };
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as CapturedRequest['body'];
        calls.push({ url: String(url), body });
        return sseResponse(replyForStage(body));
    }) as typeof fetch;
    try {
        await store.generate();
        const firstMessages = (calls[0]?.body.messages ?? []) as Array<{ role: string; content: string }>;
        const firstJoined = firstMessages.map(m => m.content).join('\n');
        const secondMessages = (calls[1]?.body.messages ?? []) as Array<{ role: string; content: string }>;
        const secondJoined = secondMessages.map(m => m.content).join('\n');
        const lastFirst = firstMessages[firstMessages.length - 1];
        const lastSecond = secondMessages[secondMessages.length - 1];
        check('端到端：统一端点请求形状（宿主路由、quiet、custom 源透传、reverse_proxy=端点地址、温度 1、不发 max_tokens、流式恒开、思考强度 high）',
            // chat_completion_source 恒 'custom' 是跨模块契约：宿主按源分派
            // 错误帧形状，只有 OpenAI 形态带 id 前缀（claude/makersuite 等
            // 支不带，custom 不在其列）——host/api-error.ts 的信封判据有效
            // 性系于此。改此处出站源必须连同那边的判据与核实记录一起复核。
            calls.length === 3
            && calls[0].url === '/api/backends/chat-completions/generate'
            && calls[0].body.type === 'quiet' && calls[0].body.chat_completion_source === 'custom'
            && calls[0].body.reverse_proxy === 'https://smoke.example.com/v1' && calls[0].body.proxy_password === 'sk-smoke'
            && calls[0].body.model === 'smoke-model' && calls[0].body.temperature === 1
            && !('max_tokens' in calls[0].body) && calls[0].body.stream === true
            && calls[0].body.reasoning_effort === 'high'
            && !('response_format' in calls[0].body));
        check('端到端：curator 段走引擎管线（策展指令全文进 messages＋assistant prefill 追加）',
            firstJoined.includes('[任务：策展人设 schema]') && firstJoined.includes(REFERENCE_MODULES_OPEN_TAG)
            && !firstJoined.includes('{{charInfo}}') && !firstJoined.includes('{{userRequirements}}')
            && lastFirst?.role === 'assistant' && lastFirst?.content.startsWith('```yaml'));
        check('端到端：personaGen 段消费策展产出（<target_schema> 含 curator 输出、生成指令在场）',
            secondJoined.includes('[任务：生成用户人设]')
            && secondJoined.includes(CATALOG_DEFINITIONS_OPEN_TAG) && secondJoined.includes('<target_schema>')
            && secondJoined.includes('基本信息:') && secondJoined.includes('[SYSTEM_OP: LOGIC_CONSTRAINT]')
            && !secondJoined.includes('{{template}}')
            && lastSecond?.role === 'assistant' && lastSecond?.content.startsWith('```yaml'));
        check('端到端：三段链结果落地（结果框是最终档案＝末轮审稿修订后的那一份、YAML 剥围栏、策展正常不置回退旗、互斥复位）',
            store.resultText === '姓名: 阿德\n年龄: 20'
            && store.schemaFallback === false
            && store.isProcessing === false && store.processingLabel === '',
            `result=${store.resultText}`);

        // 破限注入 e2e：选中「冒烟破限」→ 每段请求的首条消息＝assistant 开场
        // 原文（SSE 桩按消息内容回内容，生成正常完成）。「恰一次」机判锁双注入：
        // 前缀在每段全文恰出现一次——调用点漏注与重复注都翻红。三段都钉（漏掉
        // 哪一段都在生成链新增一段时才暴露，而那一段漏注时整轮结果照常回来，
        // 只有计数红）。key 写入放 try/finally 复位：e2e 中途 FAIL 不把键泄漏给
        // 后续用例（同进程共享 extension_settings 单例，键状态非隔离）
        const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
        writeJailbreakPreset('冒烟破限');
        try {
            store.requestText = '破限注入试验';
            await store.generate();
            const jailbreakStages = calls.map(call => stageOfRequest(call.body));
            const jailbreakBodies = [calls[3], calls[4], calls[5]].map(call => call?.body.messages ?? []);
            const jailbreakHeads = jailbreakBodies.map(messages => messages[0]);
            check('端到端：破限注入前缀按原角色恰一次插每一段请求最前（三段都钉，双注入/漏注入守门）',
                calls.length === 6
                && jailbreakStages.slice(3).join(',') === 'curator,personaGen,personaReview'
                && jailbreakHeads.every(head => head?.role === 'assistant' && head.content === '破限开场白')
                && jailbreakBodies.every(messages => countOccurrences(messages.map(m => m.content).join('\n'), '破限开场白') === 1)
                && jailbreakBodies.every(messages => messages.length > 1),
                `stages=${jailbreakStages.join(',')} heads=${JSON.stringify(jailbreakHeads)}`);

            // 观测面收敛（dump 前缀段）：选中预设后 dump 的消息段＝实发序列
            // （前缀＋组装，同一 composeOutbound 实现），头部计数行写「= 破限
            // 前缀 P 条 + 组装 M 条」、前缀条目带标注——漏传 prelude 即在此翻红
            const jbDumpText = await (toolkitGlobalPort().prompts as { dump: (task?: string) => Promise<string> } | undefined)
                ?.dump('persona_gen') ?? '';
            check('dump 口：观测面收敛（选中预设＝实发序列含破限前缀段与计数行）',
                jbDumpText.includes('消息数组（') && jbDumpText.includes('= 破限前缀 2 条 + 组装 ')
                && jbDumpText.includes('（破限前缀）') && jbDumpText.includes('破限开场白'),
                `head=${jbDumpText.split('\n').find(l => l.includes('消息数组（')) ?? '（无）'}`);

            // 悬空选中：fail-soft——生成照常、首条回到任务消息（无注入）
            writeJailbreakPreset('不存在预设');
            store.requestText = '悬空破限试验';
            await store.generate();
            const noJbFirst = (calls[6]?.body.messages ?? [])[0];
            check('端到端：破限预设悬空时生成照常且不注入',
                calls.length === 9
                && noJbFirst.role !== 'assistant' && noJbFirst.content !== '破限开场白'
                && store.isProcessing === false,
                `first=${JSON.stringify(noJbFirst)} calls=${calls.length}`);
        } finally {
            writeJailbreakPreset('');
        }

        // 取消通道：挂起不响应的端点（只认 signal）＋「停止」→ 中断传播、
        // 互斥复位、结果不误写、取消不作错误弹报（lastRun.request 换种子
        // 证明第二次生成确已进入链路；轮询等 fetch 真被进入后才取消——
        // 请求中 abort→归类才是主战场，pre-aborted 入口只是兜底）
        let fetchEntered = false; // 闭包内赋值：真值连词判定（初始化字面量会窄化，禁 === true 比较）
        globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
            fetchEntered = true;
            return new Promise<Response>((_resolve, reject) => {
                const abortLike = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
                if (init?.signal?.aborted) abortLike();
                else init?.signal?.addEventListener('abort', abortLike);
            });
        }) as typeof fetch;
        const resultBeforeCancel = store.resultText;
        store.requestText = '取消试验';
        const pending = store.generate();
        for (let i = 0; i < 100 && !fetchEntered; i++) await new Promise(r => setTimeout(r, 1));
        store.cancelGeneration();
        await pending;
        check('端到端：生成可中途停止（请求已发出后取消、归类为取消、复位不误写）',
            fetchEntered
            && store.lastRun?.request === '取消试验'
            && store.isProcessing === false && store.processingLabel === ''
            && store.resultText === resultBeforeCancel,
            `fetchEntered=${String(fetchEntered)} result=${store.resultText}`);

        // 切会话取消：CHAT_CHANGED 到达时中止 in-flight 那轮——它带的
        // wiText/开场白快照属于旧会话，放它跑完就是把旧档案落进新会话的
        // 编辑现场。挂起桩只认 signal，与上条同一形状。
        let chatSwitchEntered = false;
        globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
            chatSwitchEntered = true;
            return new Promise<Response>((_resolve, reject) => {
                const abortLike = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
                if (init?.signal?.aborted) abortLike();
                else init?.signal?.addEventListener('abort', abortLike);
            });
        }) as typeof fetch;
        const resultBeforeChatSwitch = store.resultText;
        // 记账判据取 nextId 增量而非记录条数：ring 满了以后 push 不再涨长度，
        // 按条数看会得到「一条没记」的假象。恰好 +1 同时钉住「无双记」。
        const runlogIdBeforeChatSwitch = useRunlogStore().nextId;
        store.requestText = '切聊天取消试验';
        const chatSwitchPending = store.generate();
        for (let i = 0; i < 100 && !chatSwitchEntered; i++) await new Promise(r => setTimeout(r, 1));
        store.handleChatChanged();
        await chatSwitchPending;
        check('端到端：切聊天中止 in-flight 生成（互斥即刻复位、结果不误写、lastRun 清空）',
            chatSwitchEntered
            && store.isProcessing === false && store.processingLabel === ''
            && store.resultText === resultBeforeChatSwitch && store.lastRun === null,
            `fetchEntered=${String(chatSwitchEntered)} result=${store.resultText}`);
        const runlogAfterChatSwitch = useRunlogStore();
        const cancelRunRecord = runlogAfterChatSwitch.records.find(record => record.id >= runlogIdBeforeChatSwitch);
        check('端到端：取消在运行日志留痕（传输层单一写入点恰落一条 persona 失败记录，无双记）',
            runlogAfterChatSwitch.nextId === runlogIdBeforeChatSwitch + 1
            && cancelRunRecord?.task === 'persona' && cancelRunRecord.ok === false,
            `nextId ${runlogIdBeforeChatSwitch}→${runlogAfterChatSwitch.nextId} `
            + `record=${JSON.stringify(cancelRunRecord && { id: cancelRunRecord.id, task: cancelRunRecord.task, ok: cancelRunRecord.ok })}`);

        // 切聊天落在「世界书收集」窗口内：收集是真挂起点且不收取消信号，
        // abort 抵达时这一轮已在飞、lastRun 却还没落。桩把单书装载做成手动
        // resolve 的 Promise 造出该窗口（可换实现位经 scripts/smoke.mjs 的
        // loadWorldInfo 转发层，模块存根取的是函数快照）。
        const windowStubs = smokeStubs();
        const originalChatForWindow = windowStubs.chat_metadata;
        const defaultWorldBookImpl = windowStubs.loadWorldInfoImpl;
        let worldBookEntered = false;
        let releaseWorldBook = (): void => {};
        windowStubs.loadWorldInfoImpl = () => new Promise(resolve => {
            worldBookEntered = true;
            releaseWorldBook = () => resolve({
                entries: { '1': { uid: 1, comment: '窗口条目', content: '窗口内容', key: [], disable: false, depth: 1, position: 0 } },
            });
        });
        windowStubs.setChatMetadata({ ...originalChatForWindow, world_info: '冒烟世界书' });
        let collectWindowFetchCalls = 0;
        globalThis.fetch = (() => {
            collectWindowFetchCalls += 1;
            throw new Error('收集窗口内不该发出请求——这一轮已被判死');
        }) as typeof fetch;
        const resultBeforeCollectWindow = store.resultText;
        try {
            store.requestText = '收集窗口切聊天试验';
            const collectWindowPending = store.generate();
            for (let i = 0; i < 100 && !worldBookEntered; i++) await new Promise(r => setTimeout(r, 1));
            store.handleChatChanged();
            releaseWorldBook();
            await collectWindowPending;
            check('端到端：切聊天落在世界书收集窗口内也不写回旧会话 lastRun（请求未发出、结果不误写、互斥复位）',
                worldBookEntered
                && store.lastRun === null
                && collectWindowFetchCalls === 0
                && store.resultText === resultBeforeCollectWindow
                && store.isProcessing === false && store.processingLabel === '',
                `worldBookEntered=${String(worldBookEntered)} lastRun=${JSON.stringify(store.lastRun)} `
                + `fetch=${collectWindowFetchCalls} isProcessing=${String(store.isProcessing)}`);
        } finally {
            windowStubs.setChatMetadata(originalChatForWindow);
            windowStubs.loadWorldInfoImpl = defaultWorldBookImpl;
        }

        // 空白正文 fail fast（空白也算空的单点判据）：fetch 桩回纯空白 SSE 流
        // ——curator 段 fail-soft 回退默认模板照常，personaGen 段 finalize 抛
        // 「API 返回为空」。用户可见面三件套机判：错误 toast 在场（toastr
        // 间谍临时接管、验毕删除）、结果框保持原值（falsy 判空下纯空白会
        // 静默成功并置空结果框——保留断言的前提是原值非空）、互斥态干净。
        // 调用数只 +2：档案段这一关就抛了，第三段（审稿）压根没发
        const blankToastErrors: string[] = [];
        const blankWindow = globalThis as unknown as { toastr?: Record<string, (message: string) => void> };
        blankWindow.toastr = { error: message => { blankToastErrors.push(message); } };
        const resultBeforeBlank = store.resultText;
        store.requestText = '空白正文试验';
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as CapturedRequest['body'] });
            return sseResponse('  \n\t ');
        }) as typeof fetch;
        try {
            await store.generate();
            check('端到端：档案段空白正文抛「API 返回为空」（档案段 finalize 就抛，审稿轮压根没发：错误 toast 在场、结果框保持原值、互斥态干净）',
                calls.length === 11
                && resultBeforeBlank.length > 0 && store.resultText === resultBeforeBlank
                && store.isProcessing === false && store.processingLabel === ''
                && blankToastErrors.length === 1 && blankToastErrors[0].includes('API 返回为空'),
                `toast=${JSON.stringify(blankToastErrors)} result=${store.resultText}`);
        } finally {
            delete blankWindow.toastr;
        }

        // 策展回退可见性：curator 段回拒答散文 → fail-soft 回退内置骨架照常出
        // 档案，但结果必须带「策展回退」标记（store 态 → PersonaTab 简报行）
        // ——否则打包版用户分不清「政策没生效」与「策展回退」（无 devtools，
        // log.warn 不可见）。三段照发：回退不断链。
        const FALLBACK_PERSONA_YAML = '```yaml\n基本信息:\n  年龄: 26\n  性别: 女\n```';
        const callsBeforeFallbackCase = calls.length;
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as CapturedRequest['body'];
            calls.push({ url: String(url), body });
            const stage = stageOfRequest(body);
            if (stage === 'curator') return sseResponse('抱歉，我无法按要求输出。');
            if (stage === 'personaGen') return sseResponse(FALLBACK_PERSONA_YAML);
            if (stage === 'personaReview') return sseResponse('无需修改');
            throw new Error(`冒烟桩认不出请求段：${JSON.stringify(body.messages.slice(-1))}`);
        }) as typeof fetch;
        await store.generate();
        check('端到端：策展回退可见（curator 拒答→内置骨架照常出档案＋回退标记置位＋三段照发）',
            calls.length === callsBeforeFallbackCase + 3
            && store.schemaFallback === true
            && store.resultText === '基本信息:\n  年龄: 26\n  性别: 女'
            && store.reviewBriefText.includes('无可挑剔'),
            `calls=${calls.length - callsBeforeFallbackCase} fallback=${String(store.schemaFallback)} result=${store.resultText}`);

        // 宿主错误信封在 curator 段：必须抛错中断整条链——第二段不得发出。
        // 事故原型实证：信封不认 → 错误正文当 schema → 第二段照发，prefill
        // 首键派生成「连接目标服务失败:」。判据取「调用数只 +1」＝第二段
        // 根本没发（只断言 toast 会在「发了但第二段也失败」时假绿）。
        const envelopeToastErrors: string[] = [];
        const envelopeWindow = globalThis as unknown as { toastr?: Record<string, (message: string) => void> };
        envelopeWindow.toastr = { error: message => { envelopeToastErrors.push(message); } };
        const callsBeforeEnvelope = calls.length;
        const resultBeforeEnvelope = store.resultText;
        store.requestText = '宿主错误信封试验';
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as CapturedRequest['body'] });
            const encoder = new TextEncoder();
            const frames = [
                encoder.encode(`data: ${JSON.stringify({
                    id: 'tauritavern-error-chunk-1791461520',
                    choices: [{ delta: { content: '[API 错误]\n连接目标服务失败：当前网络、VPN、代理或接口地址可能暂时不可用。' } }],
                })}\n\n`),
                encoder.encode('data: [DONE]\n\n'),
            ];
            return {
                ok: true,
                status: 200,
                body: { getReader: () => ({
                    read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true },
                    cancel: async () => undefined,
                }) },
            } as unknown as Response;
        }) as typeof fetch;
        try {
            await store.generate();
            const secondStageSent = calls.length > callsBeforeEnvelope + 1;
            check('端到端：curator 段遇宿主错误信封即中断（第二段不发出、错误 toast 在场、结果框与互斥态干净）',
                calls.length === callsBeforeEnvelope + 1
                && !secondStageSent
                && envelopeToastErrors.length === 1 && envelopeToastErrors[0].includes('连接目标服务失败')
                && store.resultText === resultBeforeEnvelope
                && store.isProcessing === false && store.processingLabel === '',
                `calls=${calls.length - callsBeforeEnvelope} toast=${JSON.stringify(envelopeToastErrors).slice(0, 60)}`);
        } finally {
            delete envelopeWindow.toastr;
        }

        // 流内上游错误帧 e2e（判别性主断言，真跑 runGeneration）：带起手词的段
        // （curator 与档案段）均以 assistant 起手词结尾，curator 首发被网关以
        // 「末条是模型轮」400 拒收（真实事故帧）——必须触发去起手词重试且第二次
        // 成功。锁用户可见行为（实发 fetch body 的末条角色），不锁上游文案形状。
        // 档案段末条＝user 是轮内即学即用的机判：学习落在策展段重试里，
        // 档案段必须接着不带起手词（读入口快照的实现会在此露馅）。
        // 本例直调 runGeneration：事件回调只记账，设置域必须纹丝不动——能力
        // 记忆是组合根（store）的职责，生成链不反写兄弟域。
        let learnedEvents = 0;
        const prefillRetryBefore = calls.length;
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as CapturedRequest['body'];
            calls.push({ url: String(url), body });
            // 「末条是模型轮」才拒收——真事故的判别依据在 body 里，不在调用序
            // 里：端点不收带起手词的请求，去掉起手词的重试即通；后续段因轮内
            // 即学即用也不再带起手词，桩不必（也不该）再数第几次调用
            if (endsWithPrefill(body)) {
                return fakeSSEStream([
                    `data: {"error":{"message":"upstream status 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"Requests ending with a model turn are not supported.\\",\\"status\\":\\"INVALID_ARGUMENT\\"}}","type":"invalid_request_error","param":null,"code":"invalid_argument"}}\n\n`,
                ]);
            }
            return sseResponse(replyForStage(body));
        }) as typeof fetch;
        const prefillRun = await runGeneration({
            route: { providerId: 'smoke-endpoint', identity: { kind: 'provider', url: 'https://smoke.example.com/v1', key: 'sk-smoke' }, model: 'smoke-model', temperature: 1, reasoningEffort: 'high', noPrefill: false },
            request: '流内错误帧重试试验',
            wiText: '',
            greetingsText: '',
            onPrefillUnsupported: () => { learnedEvents += 1; },
        });
        const first400 = calls[prefillRetryBefore]?.body.messages ?? [];
        const retry400 = calls[prefillRetryBefore + 1]?.body.messages ?? [];
        const afterLearn = calls[prefillRetryBefore + 2]?.body.messages ?? [];
        check('端到端：流内上游错误帧触发去 prefill 重试（首发末条 assistant、重试末条 user、档案段接着不带起手词、成功落地）',
            calls.length === prefillRetryBefore + 4
            && first400[first400.length - 1]?.role === 'assistant'
            && retry400[retry400.length - 1]?.role === 'user'
            && retry400.length === first400.length - 1
            && afterLearn[afterLearn.length - 1]?.role === 'user'
            && learnedEvents === 1
            && readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill === false
            && prefillRun.profile === '姓名: 阿德\n年龄: 20',
            `firstLast=${first400[first400.length - 1]?.role} retryLast=${retry400[retry400.length - 1]?.role} `
            + `afterLast=${afterLearn[afterLearn.length - 1]?.role} events=${learnedEvents} `
            + `noPrefill=${String(readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill)} profile=${prefillRun.profile}`);

        // 学习写穿设置域（判别性主断言，走组合根 store.generate()）：同一场
        // 400 家族事故重跑一次——事件必须经 store 的 handler 落到服务商条目，
        // 直调 runGeneration 不会写（上一断言已锁这条边界）。
        setProviderNoPrefill('smoke-endpoint', false);
        const learnBefore = calls.length;
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as CapturedRequest['body'];
            calls.push({ url: String(url), body });
            if (endsWithPrefill(body)) {
                return fakeSSEStream([
                    `data: {"error":{"message":"upstream status 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"Requests ending with a model turn are not supported.\\",\\"status\\":\\"INVALID_ARGUMENT\\"}}","type":"invalid_request_error","param":null,"code":"invalid_argument"}}\n\n`,
                ]);
            }
            return sseResponse(replyForStage(body));
        }) as typeof fetch;
        store.requestText = '学习触发试验';
        await store.generate();
        check('端到端：去 prefill 重试成功后端点条目落 noPrefill=true（学习经组合根写穿设置域）',
            calls.length === learnBefore + 4 && readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill === true,
            `calls=${calls.length - learnBefore} noPrefill=${String(readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill)}`);

        // 已标记端点（学习后的下一轮）：路由经 resolveTaskRoute 带出 noPrefill
        // ＝true，两条带起手词的段实发 body 末条都应是 user（起手词被摘、生成照常
        // 成功；审稿轮本就不带起手词，末条恒 user 不构成这条的判据）
        const gatedBefore = calls.length;
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as CapturedRequest['body'];
            calls.push({ url: String(url), body });
            return sseResponse(replyForStage(body));
        }) as typeof fetch;
        store.requestText = '已标记端点试验';
        await store.generate();
        const gatedFirst = calls[gatedBefore]?.body.messages ?? [];
        const gatedSecond = calls[gatedBefore + 1]?.body.messages ?? [];
        check('端到端：已标记端点两条带起手词的段实发 body 末条均为 user（起手词被摘、生成照常成功）',
            readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill === true
            && calls.length === gatedBefore + 3
            && gatedFirst[gatedFirst.length - 1]?.role === 'user'
            && gatedSecond[gatedSecond.length - 1]?.role === 'user'
            && store.resultText === '姓名: 阿德\n年龄: 20'
            && store.isProcessing === false,
            `firstLast=${gatedFirst[gatedFirst.length - 1]?.role} secondLast=${gatedSecond[gatedSecond.length - 1]?.role} result=${store.resultText}`);

        // 对照（与学习触发器异向，否则判不了别）：复位后跑「400+prefill →
        // 去 prefill 重试仍 400 失败」——证据不足，不得落标记；两次失败都
        // 真实发生（重试末条 user 证明第二次是无 prefill 的重发），错误
        // toast 带真实事故文案、结果框保持原值（用户可见面锁三件套）
        setProviderNoPrefill('smoke-endpoint', false);
        const failBefore = calls.length;
        const failToastErrors: string[] = [];
        const failWindow = globalThis as unknown as { toastr?: Record<string, (message: string) => void> };
        failWindow.toastr = { error: message => { failToastErrors.push(message); } };
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as CapturedRequest['body'] });
            return fakeSSEStream([
                `data: {"error":{"message":"upstream status 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"Requests ending with a model turn are not supported.\\",\\"status\\":\\"INVALID_ARGUMENT\\"}}","type":"invalid_request_error","param":null,"code":"invalid_argument"}}\n\n`,
            ]);
        }) as typeof fetch;
        const resultBeforeFail = store.resultText;
        try {
            store.requestText = '重试仍失败对照试验';
            await store.generate();
        } finally {
            delete failWindow.toastr;
        }
        const failFirst = (calls[failBefore]?.body.messages ?? []) as Array<{ role: string }>;
        const failRetry = (calls[failBefore + 1]?.body.messages ?? []) as Array<{ role: string }>;
        check('端到端：重试仍失败不落标记（两次真实失败、错误 toast 带事故文案、结果框保持原值、noPrefill 保持 false）',
            calls.length === failBefore + 2
            && failFirst[failFirst.length - 1]?.role === 'assistant'
            && failRetry[failRetry.length - 1]?.role === 'user'
            && failToastErrors.length === 1 && failToastErrors[0].includes('upstream status 400')
            && store.resultText === resultBeforeFail && store.isProcessing === false
            && readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill === false,
            `calls=${calls.length - failBefore} toast=${JSON.stringify(failToastErrors).slice(0, 60)} `
            + `result=${store.resultText} noPrefill=${String(readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill)}`);
    } finally {
        globalThis.fetch = originalFetch;
        writeApiDomain([]);
        seedTaskProfiles('', '');
    }
}

// ---------------------------------------------------------------------------
// 7) 审稿回合（AI 调用 3）
// ---------------------------------------------------------------------------

/** 审稿探针夹具：策展段回两块骨架（档案块集是它的子集，档案段才过 finalize）。 */
const REVIEW_STUB_CURATOR_YAML = '```yaml\n基本信息:\n身份定位:\n别名与名号:\n生活习性:\n起床:\n夜宵:\n```';

/** 审稿探针夹具档案：两块四叶，四个叶值互不相同——首轮本身不触发任何判定。 */
const REVIEW_STUB_PROFILE_YAML = '```yaml\n基本信息:\n  身份定位: 城南码头3号泊位的夜班调度\n  别名与名号: 街面上都叫他「阿槐」\n生活习性:\n  起床: 天没亮就起，先去巷口买豆浆\n  夜宵: 收摊前必去吃一碗热汤面\n```';

/** 同一份档案剥围栏后的正文（结果框该逐字等于它）。 */
const REVIEW_STUB_PROFILE_TEXT = '基本信息:\n  身份定位: 城南码头3号泊位的夜班调度\n  别名与名号: 街面上都叫他「阿槐」\n生活习性:\n  起床: 天没亮就起，先去巷口买豆浆\n  夜宵: 收摊前必去吃一碗热汤面';

/**
 * 目录漂移探针夹具：`基本信息`（目录内块）里多写了一叶 `籍贯`，外加一块
 * 机制挂载块 `生活习性`（整块在目录外，它的叶按设计永远不必补）。两个形状
 * 各钉一头：前者该进漂移计数，后者不该——触发口径含了它，告警就废了。
 */
const REVIEW_STUB_DRIFT_PROFILE_YAML = '```yaml\n基本信息:\n  身份定位: 城南码头3号泊位的夜班调度\n  籍贯: 城南码头镇\n生活习性:\n  起床: 天没亮就起，先去巷口买豆浆\n  夜宵: 收摊前必去吃一碗热汤面\n```';

/**
 * 审稿整档回执的落档期望：只改了 起床 一叶的档案（剥围栏后正文）。骨架与未涉重
 * 叶刻意和 REVIEW_STUB_PROFILE_TEXT 逐字相同——「未涉重叶逐字保留」就是靠这组
 * 逐字相等断言钉住的。
 */
const REVIEW_STUB_REWRITE_TEXT = '基本信息:\n  身份定位: 城南码头3号泊位的夜班调度\n  别名与名号: 街面上都叫他「阿槐」\n生活习性:\n  起床: 天亮透了才出门，先给面摊送两碗豆浆过去\n  夜宵: 收摊前必去吃一碗热汤面';

/** 整档回执＝落档期望套围栏（模型按两态契约回的完整档案）。 */
const REVIEW_STUB_REWRITE_YAML = '```yaml\n' + REVIEW_STUB_REWRITE_TEXT + '\n```';

/**
 * 皮毛漂移回执：与整档回执同一处改动，但未涉重的 身份定位 被模型顺手把
 * 「3」写成全角「３」——归一后与原值同值，合并守卫必须还原原文行（落档期望
 * 仍是 REVIEW_STUB_REWRITE_TEXT，模型变体不得落档），简报也不得把它点成
 * 修订叶。
 */
const REVIEW_STUB_COSMETIC_YAML = '```yaml\n基本信息:\n  身份定位: 城南码头３号泊位的夜班调度\n  别名与名号: 街面上都叫他「阿槐」\n生活习性:\n  起床: 天亮透了才出门，先给面摊送两碗豆浆过去\n  夜宵: 收摊前必去吃一碗热汤面\n```';

/** 多行列表叶探针档案：夜宵 承载为列表叶（'- ' 项），其余与默认档案同构。 */
const REVIEW_STUB_LIST_PROFILE_YAML = '```yaml\n基本信息:\n  身份定位: 城南码头3号泊位的夜班调度\n  别名与名号: 街面上都叫他「阿槐」\n生活习性:\n  起床: 天没亮就起，先去巷口买豆浆\n  夜宵:\n    - 收摊前必去吃一碗热汤面\n    - 再绕到桥头买两串烤豆腐\n```';

/**
 * 多行列表叶修订回执：整份档案的叶层刻意比原档深一级（叶行 4 空格、列表项
 * 8 空格）——移植守卫必须把模型该叶行区间整体平移回原档列位（项行 6 空格），
 * 且新增的第三项一并落档。
 */
const REVIEW_STUB_LIST_REPLY_YAML = '```yaml\n基本信息:\n    身份定位: 城南码头3号泊位的夜班调度\n    别名与名号: 街面上都叫他「阿槐」\n生活习性:\n    起床: 天没亮就起，先去巷口买豆浆\n    夜宵:\n        - 收摊前先给面摊伙计送一碗热汤面\n        - 再绕到桥头买两串烤豆腐\n        - 顺手给守渡口的老人捎一份\n```';

/** 多行列表叶修订的落档期望：键行回 2 格、列表项平移到 6 格、三项齐全。 */
const REVIEW_STUB_LIST_MERGED = '基本信息:\n  身份定位: 城南码头3号泊位的夜班调度\n  别名与名号: 街面上都叫他「阿槐」\n生活习性:\n  起床: 天没亮就起，先去巷口买豆浆\n  夜宵:\n      - 收摊前先给面摊伙计送一碗热汤面\n      - 再绕到桥头买两串烤豆腐\n      - 顺手给守渡口的老人捎一份';

/** 骨架漂移回执：模型把 夜宵 整叶删了——修订轮不得动策展结果，整轮作废。 */
const REVIEW_STUB_SKELETON_DRIFT_YAML = '```yaml\n基本信息:\n  身份定位: 城南码头3号泊位的夜班调度\n  别名与名号: 街面上都叫他「阿槐」\n生活习性:\n  起床: 天没亮就起，先去巷口买豆浆\n```';

/** 零变化回执：回了一份与原档逐字相同的档案——说了要修订却什么都没改。 */
const REVIEW_STUB_ZERO_CHANGE_YAML = '```yaml\n' + REVIEW_STUB_PROFILE_TEXT + '\n```';

/** 新增同值回执：把 起床 改成与 夜宵 完全同值——制造新的完全同值组。 */
const REVIEW_STUB_NEW_DUP_YAML = '```yaml\n基本信息:\n  身份定位: 城南码头3号泊位的夜班调度\n  别名与名号: 街面上都叫他「阿槐」\n生活习性:\n  起床: 收摊前必去吃一碗热汤面\n  夜宵: 收摊前必去吃一碗热汤面\n```';

/**
 * 空值改写回执：整档抄写时把有值的 夜宵 漏抄成空值（`键:` 形态）——这不是
 * 修订而是丢内容。除这一处空值外与整档回执同构（骨架一致、起床真改且与原值
 * 不同），骨架校验与零变化/同值组两道校验都拦不住它——唯一该拦它的是空值守卫。
 */
const REVIEW_STUB_EMPTY_VALUE_YAML = '```yaml\n基本信息:\n  身份定位: 城南码头3号泊位的夜班调度\n  别名与名号: 街面上都叫他「阿槐」\n生活习性:\n  起床: 天亮透了才出门，先给面摊送两碗豆浆过去\n  夜宵:\n```';

/**
 * 真实 400 帧（网关「末条是模型轮」那一族）。本探针用它断言**审稿轮 400 不
 * 走去起手词重试**：审稿轮本就不带起手词，没有可去的东西，重发只会把同一条
 * 请求原样再发一遍。
 */
const REVIEW_STUB_BAD_REQUEST_FRAME = 'data: {"error":{"message":"upstream status 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"Requests ending with a model turn are not supported.\\",\\"status\\":\\"INVALID_ARGUMENT\\"}}","type":"invalid_request_error","param":null,"code":"invalid_argument"}}\n\n';

/**
 * 审稿回合探针（真跑公开入口 runGeneration／store，不直接调纯函数）：
 *   1. 审稿请求**无条件**发出（判据层零命中也发——判据层的语义检出率为零，
 *      它不是触发器；
 *   2. 实发 body 携带整份档案、指令并进 messages，且**本轮不带起手词**
 *      （末条是 user 的审稿指令）；
 *   3. 模型给的整份档案经逐叶合并守卫落档：断言改后档案逐字＝只换真变叶的
 *      那一份（未涉重叶的归一同值漂移还原为原文行），不只断言「报出命中」；
 *   4. 审稿失败时结果框仍是首轮内容、简报落降级态（不抛给用户）。
 * 读的是实发 body（calls[i].body.messages），不是传进 requestOnce 的那份
 * messages——后者与实发面可以分家，而分家不产生任何报错。
 */
async function runPersonaReviewChecks(): Promise<void> {
    const store = usePersonaStore();
    writeApiDomain([{ id: 'smoke-endpoint', name: '冒烟服务商', url: 'https://smoke.example.com/v1', key: 'sk-smoke', models: ['smoke-model'], noPrefill: false }]);
    seedTaskProfiles('smoke-endpoint', 'smoke-model');
    store.requestText = '审稿回合试验';
    store.isProcessing = false;

    const originalFetch = globalThis.fetch;
    interface ReviewStubOptions {
        /** 审稿段按尝试序取的回执（首项＝首次审稿请求该拿到的内容）。 */
        reviewReplies: string[];
        /** 审稿段首次请求是否被 400 拒收（用来断言本轮不走去起手词重试）。 */
        rejectReview?: boolean;
        /**
         * 审稿段的 fetch 直接 reject（模拟非 400 族的传输失败：网关 5xx 原文、
         * 中途断流等）。用来断言「档案已经生成成功」时审稿怎么失败都只降级。
         */
        failReview?: string;
        /** 档案段的回执（默认 REVIEW_STUB_PROFILE_YAML；漂移那组换一份带目录外叶的）。 */
        profileYaml?: string;
    }
    const installStub = (calls: CapturedRequest[], options: ReviewStubOptions): void => {
        let rejected = false;
        let replied = 0;
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as CapturedRequest['body'];
            calls.push({ url: String(url), body });
            const stage = stageOfRequest(body);
            if (stage === 'curator') return sseResponse(REVIEW_STUB_CURATOR_YAML);
            if (stage === 'personaGen') return sseResponse(options.profileYaml ?? REVIEW_STUB_PROFILE_YAML);
            if (stage === 'personaReview') {
                if (options.failReview) throw new Error(options.failReview);
                if (options.rejectReview && !rejected) {
                    rejected = true;
                    return fakeSSEStream([REVIEW_STUB_BAD_REQUEST_FRAME]);
                }
                const reply = options.reviewReplies[replied];
                replied += 1;
                return sseResponse(reply ?? '');
            }
            throw new Error(`审稿探针桩认不出请求段：${JSON.stringify(body.messages.slice(-1))}`);
        }) as typeof fetch;
    };
    // 能力记忆不在本段关注面（e2e 已锁它的落档口径），事件回调空实现即可
    const runReview = (request: string): Promise<GenerationResult> => runGeneration({
        route: { providerId: 'smoke-endpoint', identity: { kind: 'provider', url: 'https://smoke.example.com/v1', key: 'sk-smoke' }, model: 'smoke-model', temperature: 1, reasoningEffort: 'high', noPrefill: false },
        request,
        wiText: '',
        greetingsText: '',
        onPrefillUnsupported: () => { /* 见上方注释 */ },
    });

    try {
        // 任务头字面（变异 3 的判别力主锚）：stageOfRequest 靠它认段，常量与
        // 字面量分家——审稿任务头被改字时，stages 会抛「认不出请求段」，这条
        // 与下一条都红。
        check('审稿：任务头字面＝[任务：审稿并修订]（派发判据与字面期望分家）',
            PERSONA_REVIEW_TASK_HEAD === '[任务：审稿并修订]',
            `head=${PERSONA_REVIEW_TASK_HEAD}`);

        const plainCalls: CapturedRequest[] = [];
        installStub(plainCalls, { reviewReplies: ['无需修改'] });
        const plain = await runReview('无条件审稿试验');
        const stages = plainCalls.map(call => stageOfRequest(call.body));
        check('审稿：判据层零命中仍无条件发出审稿轮（三段实发、末段认得出审稿指令、回执「无需修改」落无可挑剔态、档案逐字未动）',
            literalDuplicateSignatures(REVIEW_STUB_PROFILE_TEXT).length === 0
            && stages.join(',') === 'curator,personaGen,personaReview'
            && plain.review.kind === 'none'
            && plain.profile === REVIEW_STUB_PROFILE_TEXT,
            `stages=${stages.join(',')} review=${JSON.stringify(plain.review)} profile=${JSON.stringify(plain.profile)}`);

        const reviewMessages = plainCalls[2].body.messages;
        const reviewJoined = reviewMessages.map(message => message.content).join('\n');
        const reviewLast = reviewMessages[reviewMessages.length - 1];
        check('审稿：指令并进 messages 且携带整份档案、末条是 user 的审稿指令（本轮不带起手词：YAML 起手词会把模型钉在续写态上、压掉「无需修改」四字态）',
            reviewJoined.includes(PERSONA_REVIEW_TASK_HEAD)
            && reviewJoined.includes('<profile>')
            && reviewJoined.includes(REVIEW_STUB_PROFILE_TEXT)
            && reviewJoined.includes(PERSONA_GEN_TASK_HEAD)
            && !reviewMessages.some(message => message.role === 'assistant')
            && reviewLast?.role === 'user'
            && reviewLast.content.startsWith(PERSONA_REVIEW_TASK_HEAD),
            `lastRole=${reviewLast?.role} assistantTurns=${reviewMessages.filter(message => message.role === 'assistant').length} hasProfile=${reviewJoined.includes(REVIEW_STUB_PROFILE_TEXT)}`);

        const rejectCalls: CapturedRequest[] = [];
        installStub(rejectCalls, { reviewReplies: ['无需修改'], rejectReview: true });
        const rejected = await runReview('审稿 400 不重试试验');
        check('审稿：400 不触发去起手词重试（三段共 3 次请求，没有第 4 次重发），失败落降级态并保留首轮档案（不带起手词是本轮的决定，不是端点能力降级）',
            rejectCalls.length === 3
            && rejectCalls[2].body.messages[rejectCalls[2].body.messages.length - 1]?.role === 'user'
            && rejected.review.kind === 'failed'
            && rejected.review.reason === TEXT.REVIEW_BRIEF.FAILURE_REASON.REQUEST
            && rejected.profile === REVIEW_STUB_PROFILE_TEXT,
            `calls=${rejectCalls.length} review=${JSON.stringify(rejected.review)}`);

        const rewriteCalls: CapturedRequest[] = [];
        installStub(rewriteCalls, { reviewReplies: [REVIEW_STUB_REWRITE_YAML] });
        const rewritten = await runReview('审稿整档落档试验');
        const rewrittenBrief = renderReviewBrief(rewritten.review);
        check('审稿：整份修订落档（改后档案逐字＝只换了真变叶的那一份、未涉重叶逐字保留，简报落「已修订」态并按「块·叶」点名真变叶）',
            rewritten.profile === REVIEW_STUB_REWRITE_TEXT
            && rewritten.profile.includes('  起床: 天亮透了才出门，先给面摊送两碗豆浆过去')
            && rewritten.review.kind === 'rewritten'
            && rewrittenBrief === '模型审稿：修订 1 处 —— 生活习性·起床',
            `profile=${JSON.stringify(rewritten.profile)} brief=${rewrittenBrief}`);

        const unfencedCalls: CapturedRequest[] = [];
        installStub(unfencedCalls, { reviewReplies: [REVIEW_STUB_REWRITE_TEXT] });
        const unfenced = await runReview('审稿无围栏整档回执试验');
        const unfencedBrief = renderReviewBrief(unfenced.review);
        check('审稿：无围栏整档回执落档（宽松剥围栏后仍走骨架与逐叶合并守卫）',
            unfenced.profile === REVIEW_STUB_REWRITE_TEXT
            && unfenced.review.kind === 'rewritten'
            && unfencedBrief === '模型审稿：修订 1 处 —— 生活习性·起床',
            `profile=${JSON.stringify(unfenced.profile)} brief=${unfencedBrief}`);

        const cosmeticCalls: CapturedRequest[] = [];
        installStub(cosmeticCalls, { reviewReplies: [REVIEW_STUB_COSMETIC_YAML] });
        const cosmetic = await runReview('审稿皮毛漂移还原试验');
        const cosmeticBrief = renderReviewBrief(cosmetic.review);
        check('审稿：皮毛漂移还原（未涉重叶的全角变体归一同值——原文行逐字回、模型变体不落档、简报不点它）',
            cosmetic.profile === REVIEW_STUB_REWRITE_TEXT
            && !cosmetic.profile.includes('３')
            && cosmetic.profile.includes('城南码头3号泊位的夜班调度')
            && cosmeticBrief === '模型审稿：修订 1 处 —— 生活习性·起床',
            `profile=${JSON.stringify(cosmetic.profile)} brief=${cosmeticBrief}`);

        const listCalls: CapturedRequest[] = [];
        installStub(listCalls, { reviewReplies: [REVIEW_STUB_LIST_REPLY_YAML], profileYaml: REVIEW_STUB_LIST_PROFILE_YAML });
        const listRewritten = await runReview('审稿列表叶修订试验');
        const listBrief = renderReviewBrief(listRewritten.review);
        check('审稿：多行列表叶修订（模型该叶行区间整段移植、缩进按两侧行首空白差值平移回原档列位、新增列表项一并落档）',
            listRewritten.profile === REVIEW_STUB_LIST_MERGED
            && listRewritten.profile.includes('      - 收摊前先给面摊伙计送一碗热汤面')
            && listRewritten.profile.includes('  起床: 天没亮就起，先去巷口买豆浆')
            && listBrief === '模型审稿：修订 1 处 —— 生活习性·夜宵',
            `profile=${JSON.stringify(listRewritten.profile)} brief=${listBrief}`);

        // 降级面走组合根：结果框与简报都是用户可见面，store 这条路才验得到
        const reviewToastErrors: string[] = [];
        const reviewWindow = globalThis as unknown as { toastr?: Record<string, (message: string) => void> };
        reviewWindow.toastr = { error: message => { reviewToastErrors.push(message); } };
        const blankCalls: CapturedRequest[] = [];
        try {
            installStub(blankCalls, { reviewReplies: ['  \n\t '] });
            store.requestText = '审稿空白试验';
            await store.generate();
        } finally {
            delete reviewWindow.toastr;
        }
        check('审稿：响应为空降级（结果框仍是首轮内容、简报落「没能跑完」态且原因取自白名单、不弹错误）',
            store.resultText === REVIEW_STUB_PROFILE_TEXT
            && store.reviewBriefText === `模型审稿：没能跑完，已保留上一版结果 —— ${TEXT.REVIEW_BRIEF.FAILURE_REASON.EMPTY}`
            && store.isProcessing === false
            && reviewToastErrors.length === 0,
            `result=${JSON.stringify(store.resultText)} brief=${store.reviewBriefText} toast=${JSON.stringify(reviewToastErrors)}`);

        // 降级保证是结构性的、不挑失败形态：这里让审稿段的 fetch 直接 reject
        // （非 400 族——400 族那条已有断言），并盯住两件事——结果框仍是首轮档案
        // （archive 已生成成功不该被顶成一条错误 toast），以及真因带栈进运行
        // 日志（ttlog 的 ERROR 走 console.error）。
        const storeRewriteCalls: CapturedRequest[] = [];
        installStub(storeRewriteCalls, { reviewReplies: [REVIEW_STUB_REWRITE_YAML] });
        store.requestText = '审稿 store 路径修订试验';
        await store.generate();
        check('审稿：store 路径的结果框是审稿后的那一份（不是修订前的首轮档案）：修订后档案逐字在框内、简报落「已修订」态',
            store.resultText === REVIEW_STUB_REWRITE_TEXT
            && store.reviewBriefText === '模型审稿：修订 1 处 —— 生活习性·起床'
            && store.isProcessing === false,
            `result=${JSON.stringify(store.resultText)} brief=${store.reviewBriefText}`);

        const failedRoundToastErrors: string[] = [];
        const failedRoundWindow = globalThis as unknown as { toastr?: Record<string, (message: string) => void> };
        const failedRoundErrors: string[] = [];
        const originalConsoleError = console.error;
        failedRoundWindow.toastr = { error: message => { failedRoundToastErrors.push(message); } };
        console.error = (...args: unknown[]) => { failedRoundErrors.push(args.map(arg => String(arg)).join(' ')); };
        const failCalls: CapturedRequest[] = [];
        try {
            installStub(failCalls, { reviewReplies: [], failReview: '上游 500：审稿段传输失败（冒烟注入）' });
            store.requestText = '审稿收尾抛错试验';
            await store.generate();
        } finally {
            console.error = originalConsoleError;
            delete failedRoundWindow.toastr;
        }
        check('审稿：审稿轮收尾抛错（非 400 族）也只降级不外抛——档案生成成功时结果框仍是首轮内容、简报落「没能跑完」态、不弹错误，真因带栈进运行日志',
            store.resultText === REVIEW_STUB_PROFILE_TEXT
            && store.reviewBriefText === `模型审稿：没能跑完，已保留上一版结果 —— ${TEXT.REVIEW_BRIEF.FAILURE_REASON.REQUEST}`
            && store.isProcessing === false
            && failedRoundToastErrors.length === 0
            && failCalls.length === 3
            && failedRoundErrors.some(line => line.includes('审稿轮未能完成')),
            `result=${JSON.stringify(store.resultText)} brief=${store.reviewBriefText} toast=${JSON.stringify(failedRoundToastErrors)} errorLogs=${failedRoundErrors.length}`);

        const skeletonDriftCalls: CapturedRequest[] = [];
        installStub(skeletonDriftCalls, { reviewReplies: [REVIEW_STUB_SKELETON_DRIFT_YAML] });
        const skeletonDrift = await runReview('审稿骨架漂移试验');
        const zeroChangeCalls: CapturedRequest[] = [];
        installStub(zeroChangeCalls, { reviewReplies: [REVIEW_STUB_ZERO_CHANGE_YAML] });
        const zeroChange = await runReview('审稿零变化试验');
        const newDuplicateCalls: CapturedRequest[] = [];
        installStub(newDuplicateCalls, { reviewReplies: [REVIEW_STUB_NEW_DUP_YAML] });
        const newDuplicate = await runReview('审稿制造新同值试验');
        const unusableBrief = `模型审稿：没能跑完，已保留上一版结果 —— ${TEXT.REVIEW_BRIEF.FAILURE_REASON.UNUSABLE}`;
        check('审稿：骨架漂移拒（模型删一叶＝动了策展结果——整轮回滚，简报落「解析不了审稿结果」）',
            skeletonDrift.profile === REVIEW_STUB_PROFILE_TEXT
            && renderReviewBrief(skeletonDrift.review) === unusableBrief,
            `profile=${JSON.stringify(skeletonDrift.profile)} brief=${renderReviewBrief(skeletonDrift.review)}`);
        check('审稿：零变化拒绝（没回「无需修改」却逐叶比对零改动——回滚首轮档案，简报落「解析不了审稿结果」）',
            zeroChange.profile === REVIEW_STUB_PROFILE_TEXT
            && renderReviewBrief(zeroChange.review) === unusableBrief,
            `profile=${JSON.stringify(zeroChange.profile)} brief=${renderReviewBrief(zeroChange.review)}`);
        check('审稿：新增完全同值组拒（原样迁移：修订撞出与未改叶完全同值的新组——回滚首轮档案，简报落「解析不了审稿结果」）',
            newDuplicate.profile === REVIEW_STUB_PROFILE_TEXT
            && renderReviewBrief(newDuplicate.review) === unusableBrief,
            `profile=${JSON.stringify(newDuplicate.profile)} brief=${renderReviewBrief(newDuplicate.review)}`);

        const emptyValueCalls: CapturedRequest[] = [];
        installStub(emptyValueCalls, { reviewReplies: [REVIEW_STUB_EMPTY_VALUE_YAML] });
        const emptyValue = await runReview('审稿空值改写试验');
        check('审稿：空值改写拒绝（模型漏抄值不得清空原档——整轮回滚，简报落「解析不了审稿结果」）',
            emptyValue.profile === REVIEW_STUB_PROFILE_TEXT
            && renderReviewBrief(emptyValue.review) === unusableBrief,
            `profile=${JSON.stringify(emptyValue.profile)} brief=${renderReviewBrief(emptyValue.review)}`);

        // 目录漂移告警：盯 console.warn——ttlog 的 WARN 就是 console.warn ＋
        // 环形缓冲，两条路径同一份数据，探针抓前者即可。载荷口径钉两件事：只有
        // 计数与符号名（**不带档案内文**——运行日志会被用户翻，档案正文是私事），
        // 触发只认「目录内块里写出的目录外叶」（机制挂载块那两叶不进，否则每份
        // 正常档案都喊漂移）。
        const driftWarns: string[] = [];
        const originalConsoleWarn = console.warn;
        console.warn = (...args: unknown[]) => { driftWarns.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); };
        const driftCalls: CapturedRequest[] = [];
        let driftRun: GenerationResult | undefined;
        try {
            installStub(driftCalls, { reviewReplies: ['无需修改'], profileYaml: REVIEW_STUB_DRIFT_PROFILE_YAML });
            driftRun = await runReview('审稿目录漂移告警试验');
        } finally {
            console.warn = originalConsoleWarn;
        }
        const driftLines = driftWarns.filter(line => line.includes('目录漂移'));
        const driftPayload = JSON.parse(driftLines[0]?.slice(driftLines[0].indexOf('{')) ?? '{}') as Record<string, unknown>;
        check('审稿：目录漂移 warn 打在审稿轮收尾（模型回「无需修改」那条路也打：没人修订就没人会发现目录漂了），载荷只有计数与符号名、不带档案内文，机制挂载块的叶不进计数',
            driftLines.length === 1
            && driftRun?.review.kind === 'none'
            && driftPayload.catalogDriftLeaves === 1
            && driftPayload.mechanismBlocksOutsideCatalog === 1
            && driftPayload.unrecognizedLeavesTotal === 3
            && String(driftPayload.symbol).includes('catalogDriftLeaves')
            && !driftLines[0].includes('城南码头镇')
            && !driftLines[0].includes('天没亮就起')
            && !driftLines[0].includes('夜班调度'),
            `warn=${driftLines[0] ?? '（未打出）'}`);
        // 零漂移时不打：默认那份档案（目录内块只用目录里的叶 ＋ 一块机制挂载块）
        // 同样走完整条链，一条目录漂移 warn 都不该有。
        const cleanWarns: string[] = [];
        const cleanCalls: CapturedRequest[] = [];
        console.warn = (...args: unknown[]) => { cleanWarns.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); };
        try {
            installStub(cleanCalls, { reviewReplies: ['无需修改'] });
            await runReview('审稿零漂移不告警试验');
        } finally {
            console.warn = originalConsoleWarn;
        }
        check('审稿：目录漂移计数为零时一条 warn 都不打（默认夹具无目录外叶、机制块不计）',
            cleanWarns.filter(line => line.includes('目录漂移')).length === 0
            && analyzeCatalogDrift(REVIEW_STUB_PROFILE_TEXT).catalogDriftLeaves.length === 0
            && analyzeCatalogDrift(REVIEW_STUB_PROFILE_TEXT).mechanismBlocksOutsideCatalog === 1,
            `warns=${cleanWarns.filter(line => line.includes('目录漂移')).length}`);

        const resultBeforeBriefProbe = store.resultText;
        const briefBeforeProbe = store.reviewBrief;
        store.resultText = '';
        const emptyBoxBrief = store.reviewBriefText;
        store.resultText = resultBeforeBriefProbe;
        store.reviewBrief = briefBeforeProbe;
        check('审稿：四态文案逐字（无可挑剔／没能跑完／未运行 ＋ 失败原因白名单恰三项 ＋ 空结果框时显示未运行态）',
            renderReviewBrief({ kind: 'none' }) === '模型审稿：无可挑剔'
            && renderReviewBrief({ kind: 'failed', reason: TEXT.REVIEW_BRIEF.FAILURE_REASON.REQUEST }) === '模型审稿：没能跑完，已保留上一版结果 —— 请求失败'
            && renderReviewBrief(REVIEW_BRIEF_NOT_RUN) === '模型审稿：未运行'
            && Object.values(TEXT.REVIEW_BRIEF.FAILURE_REASON).join('|') === '响应为空|解析不了审稿结果|请求失败'
            && emptyBoxBrief === '模型审稿：未运行',
            `empty=${emptyBoxBrief} reasons=${Object.values(TEXT.REVIEW_BRIEF.FAILURE_REASON).join('|')}`);
    } finally {
        globalThis.fetch = originalFetch;
        writeApiDomain([]);
        seedTaskProfiles('', '');
    }
}

// ---------------------------------------------------------------------------
// 8) store 互斥＋会话感知
// ---------------------------------------------------------------------------

async function runStoreChecks(): Promise<void> {
    // collectWorldInfoContext：全量注入（无绑定书＝空桶 → 空白上下文）
    const wiText = await collectWorldInfoContext();
    check('generation：全量注入上下文收集空桶返回空串（不抛错）', typeof wiText === 'string');

    // store 互斥：isProcessing 期间 generate 立即返回
    const store = usePersonaStore();
    store.isProcessing = true;
    store.processingLabel = '占用标记';
    const lastRunBefore = store.lastRun;
    await store.generate();
    check('store：生成期间再触发被互斥忽略（lastRun 不变、label 不变）',
        store.lastRun === lastRunBefore && store.processingLabel === '占用标记');
    store.isProcessing = false;
    store.processingLabel = '';

    // 任务模型未配置 fail fast（档案行空＝未配置态）
    seedTaskProfiles('', '');
    store.requestText = '合成需求';
    const resultBefore = store.resultText;
    await store.generate();
    check('store：任务模型未配置 fail fast（不进生成、互斥态干净、结果不误写）',
        store.isProcessing === false && store.processingLabel === '' && store.resultText === resultBefore);
    seedTaskProfiles('', '');

    // 会话感知：CHAT_CHANGED 处理（lastRun 无条件清空、开场白重置为默认档
    // ＝greetings 在场注入 #0、宿主快照无条件重拉
    // ——读取廉价，指纹门控收益为零；指纹仅用于日志观测）
    const liveStubs = (globalThis as unknown as {
        __TT_SMOKE_STUBS__: {
            characters: unknown[];
            setCharacters(v: unknown[]): void;
            eventSource: { emit(type: string, ...args: unknown[]): unknown };
        };
    }).__TT_SMOKE_STUBS__;
    const backupChars = liveStubs.characters;
    liveStubs.setCharacters([{ data: { first_mes: '你好，旅行者' } }]);
    store.refreshHostData();
    store.lastRun = { request: '旧会话需求', wiText: '旧会话 wiText 快照', greetingsText: '' };
    store.selectGreeting(null);
    store.handleChatChanged();
    check('store：CHAT_CHANGED 重置开场白为默认档（有开场白卡＝注入 #0，显式「不注入」不跨会话）＋清 lastRun',
        store.greetings.length > 0 && store.selectedGreetingIndex === 0 && store.lastRun === null);

    // 接线全链（stub 宿主 emit→eventBus.on 订阅→handleChatChanged）：
    // 直调断言只测 handler 逻辑，此条证订阅真实在位（防接线被误删）
    store.selectGreeting(null);
    liveStubs.eventSource.emit(event_types.CHAT_CHANGED);
    check('store：CHAT_CHANGED 接线全链（宿主 emit→订阅→重置默认档）',
        store.selectedGreetingIndex === 0);

    // 无开场白卡：默认回落「不注入」（null）；验毕恢复空卡基线
    liveStubs.setCharacters([]);
    store.handleChatChanged();
    check('store：无开场白卡默认不注入（greetings 空时重置为 null）',
        store.greetings.length === 0 && store.selectedGreetingIndex === null);
    liveStubs.setCharacters(backupChars);

    // charKey 兜底（stubContext.characterId=null → 'global_no_char'）
    check('store：charKey 兜底 global_no_char（|| 兜底、字符串口径）', store.charKey === 'global_no_char');

    // 显式保存点：persistUserContext 写域
    store.requestText = '保存点需求';
    store.resultText = '姓名: 保存点';
    store.persistUserContext();
    const persisted = readPersonaDomain().userContext;
    check('store：显式保存点写域（persistUserContext 落 userContext）',
        persisted.request === '保存点需求' && persisted.result === '姓名: 保存点');

    // 域写单通道 normalize 回读（未知字段丢弃的显式保真）
    const tt = extension_settings.ttToolkit as Record<string, unknown> | undefined;
    const raw = tt?.persona as Record<string, unknown> | undefined;
    if (raw) raw.junkField = '污染';
    const reread = readPersonaDomain() as unknown as Record<string, unknown>;
    check('storage：域读回 normalize 丢弃未知字段（显式保真纪律）', !('junkField' in reread));
    // 还原（去掉污染键：写域 normalize 单通道自然丢弃）
    writePersonaDomain(d => { d.userContext = { request: '', result: '' }; });
    const after = readPersonaDomain() as unknown as Record<string, unknown>;
    check('storage：写域单通道清理污染键（normalize 落盘）', !('junkField' in after));
}

// ---------------------------------------------------------------------------
// 9) 宿主可变绑定活取用回归（stub 活绑定 setter，快照转出回归红线）
// ---------------------------------------------------------------------------

interface SmokeStubs {
    characters: Record<string, unknown>[];
    chat_metadata: Record<string, unknown>;
    loadWorldInfoImpl(name: string): Promise<{ entries: Record<string, unknown> }>;
    setCharacters(v: Record<string, unknown>[]): void;
    setChatMetadata(v: Record<string, unknown>): void;
    setThisChid(v: string): void;
}

function smokeStubs(): SmokeStubs {
    return (globalThis as unknown as { __TT_SMOKE_STUBS__: SmokeStubs }).__TT_SMOKE_STUBS__;
}

function runHostLiveBindingChecks(): void {
    const stubs = smokeStubs();

    // 读通道活取用：this_chid 运行中变更即跟随
    const backupChars = stubs.characters;
    try {
        stubs.setCharacters([{ name: '卡A' }, { name: '卡B' }]);
        stubs.setThisChid('1');
        check('host 活取用：this_chid 运行中变更即跟随——stub 置新角色索引后 getCurrentCharacter 读到新卡（快照转出回归红线）',
            getCurrentCharacter()?.name === '卡B',
            `name=${String(getCurrentCharacter()?.name)}`);
    } finally {
        stubs.setCharacters(backupChars);
        stubs.setThisChid('0');
    }
}

// ---------------------------------------------------------------------------
// 10) 人设写回渲染通道（宿主描述框/人设列表的刷新调用不能漏）
// ---------------------------------------------------------------------------

interface PersonaWriteStubs {
    power_user: Record<string, unknown>;
    personasCalls: {
        initPersona: number;
        setUserAvatar: number;
        setPersonaDescription: number;
        getUserAvatarsLog: Array<[boolean, string]>;
    };
}

function personaWriteStubs(): PersonaWriteStubs {
    return (globalThis as unknown as { __TT_SMOKE_STUBS__: PersonaWriteStubs }).__TT_SMOKE_STUBS__;
}

/** 存根里登记一个人设（personas 真源＝{头像id: 显示名}）。 */
function seedPersona(stubs: PersonaWriteStubs, avatarId: string, name: string): void {
    const personas = stubs.power_user.personas as Record<string, string>;
    personas[avatarId] = name;
}

/** 刷人设列表的调用计数：渲染调用与幽灵键防御的取名调用同走 getUserAvatars，只有入参能分辨。 */
function rendersFor(log: Array<[boolean, string]>, avatarId: string): number {
    return log.filter(([doRender, openPageAt]) => doRender && openPageAt === avatarId).length;
}

async function runPersonaWriteBackChecks(): Promise<void> {
    const stubs = personaWriteStubs();
    const calls = stubs.personasCalls;
    const descriptionBefore = stubs.power_user.persona_description;
    const setDescBefore = calls.setPersonaDescription;
    const initBefore = calls.initPersona;
    const avatarLogBefore = calls.getUserAvatarsLog.length;
    const personas = stubs.power_user.personas as Record<string, string>;
    const descriptions = stubs.power_user.persona_descriptions as Record<string, { description?: string }>;
    const originalFetch = globalThis.fetch;
    // 建档分支要真走头像上传（默认头像取 PNG → /api/avatars/upload 落盘
    // 才存得住描述）——fetch 桩按 URL 分发，两个方法各回一个够用的响应
    const uploadPath = '1700000000000-smoke-persona.png';
    // 非选中人设：覆盖分支的 setUserAvatar 静默切换面只有第二张头像才可达
    //（它同样要过幽灵键防御——头像文件不在 getUserAvatars 返回表里的键会被
    // 当旧插件脏数据整条删掉），故桩的头像文件表预置了这一张
    const otherAvatarId = 'user-other.png';
    globalThis.fetch = (async (url: string | URL) => (String(url) === '/api/avatars/upload'
        ? { ok: true, status: 200, json: async () => ({ path: uploadPath }) }
        : { ok: true, status: 200, blob: async () => new Blob(['stub']) })) as unknown as typeof fetch;
    try {
        // 建档分支：personas 无同名 → 上传建档（不切选中态，描述框无须重填）
        const created = await upsertPersona('冒烟新建人设', '冒烟描述·建档');
        // 建档的落库结果必须在下一次 upsert 的 cleanGhostPersonaKeys 之前取：
        // uploadPath 不在桩的头像文件表里，再进一次写回就被当幽灵键删掉，
        // 而 avatarId 早在调 initPersona 之前就返回了——不立刻断言等于没断
        check('写回：建档分支 initPersona 恰一次且 personas 与描述符双写落地',
            calls.initPersona - initBefore === 1
            && personas[uploadPath] === '冒烟新建人设'
            && descriptions[uploadPath]?.description === '冒烟描述·建档',
            `initPersona=${calls.initPersona - initBefore} personas=${String(personas[uploadPath])} desc=${String(descriptions[uploadPath]?.description)}`);
        // 覆盖分支：把桩的选中头像登记进 personas（名字即真源键），随后
        // 按名 upsert 必走覆盖分支且命中选中态
        seedPersona(stubs, 'user-default.png', '冒烟已选人设');
        const updated = await upsertPersona('冒烟已选人设', '冒烟描述·覆盖');
        const avatarLog = calls.getUserAvatarsLog.slice(avatarLogBefore);
        check('写回：两条分支都刷人设列表（各一次 getUserAvatars(true, 本人设 id)）',
            created.created && created.avatarId === uploadPath
            && !updated.created && updated.avatarId === 'user-default.png'
            && rendersFor(avatarLog, uploadPath) === 1 && rendersFor(avatarLog, 'user-default.png') === 1,
            `log=${JSON.stringify(avatarLog)} created=${created.avatarId} updated=${updated.avatarId}`);
        check('写回：覆盖选中人设时刷描述框（setPersonaDescription 恰一次、镜像字段与描述符同步为新描述）',
            calls.setPersonaDescription - setDescBefore === 1
            && stubs.power_user.persona_description === '冒烟描述·覆盖'
            && descriptions['user-default.png']?.description === '冒烟描述·覆盖',
            `setPersonaDescription=${calls.setPersonaDescription - setDescBefore} mirror=${String(stubs.power_user.persona_description)}`);
        // 非选中人设覆盖：镜像写与刷描述框都归选中态独占，改走 setUserAvatar
        // 静默切换（列表照刷）。这条分支此前零断言，整段删掉冒烟仍全绿
        seedPersona(stubs, otherAvatarId, '冒烟未选人设');
        const setAvatarBefore = calls.setUserAvatar;
        const setDescBeforeSwitch = calls.setPersonaDescription;
        const switchLogBefore = calls.getUserAvatarsLog.length;
        const mirrorBefore = stubs.power_user.persona_description;
        const switched = await upsertPersona('冒烟未选人设', '冒烟描述·切换');
        const switchLog = calls.getUserAvatarsLog.slice(switchLogBefore);
        check('写回：覆盖非选中人设走 setUserAvatar 静默切换（恰一次、不刷描述框、镜像不动、列表仍刷本人设）',
            !switched.created && switched.avatarId === otherAvatarId
            && calls.setUserAvatar - setAvatarBefore === 1
            && calls.setPersonaDescription - setDescBeforeSwitch === 0
            && stubs.power_user.persona_description === mirrorBefore
            && descriptions[otherAvatarId]?.description === '冒烟描述·切换'
            // 幽灵键防御的取名调用与刷列表调用同走此表，两次以外即纪律漂移
            && switchLog.length === 2 && rendersFor(switchLog, otherAvatarId) === 1,
            `setUserAvatar=${calls.setUserAvatar - setAvatarBefore} setPersonaDescription=${calls.setPersonaDescription - setDescBeforeSwitch} mirror=${String(stubs.power_user.persona_description)} log=${JSON.stringify(switchLog)}`);

        // 写回保护：store 侧快照比对＋确认闸。「拒绝即中止」这条分支住在
        // .vue 里没有冒烟执行面，闸因此落在模块层（UI 只注入 confirm）——
        // 拒答时 upsertPersona 一次都不许发生，镜像与编辑现场原样留着。
        const guardStore = usePersonaStore();
        const resultBeforeGuard = guardStore.resultText;
        guardStore.resultText = '冒烟描述·闸门基线';
        seedPersona(stubs, 'user-default.png', '冒烟闸门人设');
        let guardAsked = 0;
        await overwritePersonaGuarded(guardStore, () => { guardAsked += 1; return true; });
        check('写回保护：首次成功写回即立基线（宿主正文与快照同值，确认闸不打扰）',
            guardAsked === 0
            && guardStore.syncedDescription === '冒烟描述·闸门基线'
            && guardStore.needsOverwriteConfirm() === false,
            `asked=${guardAsked} snapshot=${String(guardStore.syncedDescription)} drift=${String(guardStore.needsOverwriteConfirm())}`);
        // 宿主侧被改过（TT 里直接改／换了人设卡）→ 必须先问
        stubs.power_user.persona_description = '宿主侧手改过的正文';
        const setDescBeforeGuard = calls.setPersonaDescription;
        const initBeforeGuard = calls.initPersona;
        const setAvatarBeforeGuard = calls.setUserAvatar;
        const mirrorBeforeGuard = stubs.power_user.persona_description;
        guardAsked = 0;
        await overwritePersonaGuarded(guardStore, () => { guardAsked += 1; return false; });
        check('写回保护：宿主正文偏离快照且用户拒绝 → 问一次、零写通道调用、镜像与编辑现场原样',
            guardAsked === 1
            && calls.setPersonaDescription === setDescBeforeGuard
            && calls.initPersona === initBeforeGuard
            && calls.setUserAvatar === setAvatarBeforeGuard
            && stubs.power_user.persona_description === mirrorBeforeGuard
            && guardStore.resultText === '冒烟描述·闸门基线',
            `asked=${guardAsked} setDesc=${calls.setPersonaDescription - setDescBeforeGuard} `
            + `init=${calls.initPersona - initBeforeGuard} setAvatar=${calls.setUserAvatar - setAvatarBeforeGuard} `
            + `mirror=${String(stubs.power_user.persona_description)}`);
        guardStore.resultText = resultBeforeGuard;
    } finally {
        globalThis.fetch = originalFetch;
        delete personas[uploadPath];
        delete personas['user-default.png'];
        delete personas[otherAvatarId];
        delete descriptions[uploadPath];
        delete descriptions['user-default.png'];
        delete descriptions[otherAvatarId];
        stubs.power_user.persona_description = descriptionBefore;
    }
}

// ---------------------------------------------------------------------------
// 11) 壳真钩子（人设 tab 描述符的 onActivate）＋写回确认文案逐字锁
// ---------------------------------------------------------------------------

/**
 * 壳真钩子：宿主派生快照的刷新挂在 tab 描述符的 onActivate 上。组件内的
 * onActivated 在未启用 KeepAlive 的壳里永不触发——把刷新挂在它上面等于
 * 每次进 tab 都不刷新（壳真钩子＝壳的激活回调，ApiTab 同款）。
 *
 * 断言两件事：钩子真的注册在描述符上；它只刷派生数据（开场白），结果框里
 * 的编辑现场一个字都不动。
 */
function runShellHookChecks(): void {
    const store = usePersonaStore();
    const stubs = smokeStubs();
    const personaTab = createPersonaTab();
    const backupChars = stubs.characters;
    const resultBeforeActivate = store.resultText;
    try {
        stubs.setCharacters([{ data: { first_mes: '壳钩子新会话开场白' } }]);
        store.greetings = [];
        personaTab.onActivate?.();
        check('壳钩子：人设 tab 描述符注册 onActivate 且每次激活刷宿主派生快照（开场白跟随、resultText 编辑现场不动）',
            typeof personaTab.onActivate === 'function'
            && store.greetings.length === 1
            && store.greetings[0].content === '壳钩子新会话开场白'
            && store.resultText === resultBeforeActivate,
            `onActivate=${typeof personaTab.onActivate} greetings=${JSON.stringify(store.greetings)}`);
    } finally {
        stubs.setCharacters(backupChars);
        store.refreshHostData();
    }
    // 写回确认文案逐字锁：用户靠这段话判断「覆盖」会丢什么（来源与后果都
    // 在句子里），改字即改语义——逐字档改动同样要过这一条。
    check('写回保护：覆盖确认文案逐字（点明两种来源与覆盖后果）',
        TEXT.CONFIRM_OVERWRITE_HOST === '宿主侧的人设在生成后被修改过（可能你在 TT 里直接改过，或换了卡）。继续覆盖会丢失那些修改。仍要覆盖吗？',
        TEXT.CONFIRM_OVERWRITE_HOST);
}

/** 冒烟入口（main.ts node 分支调用）。 */
export async function runPersonaSmoke(): Promise<void> {
    console.info('=== persona 全任务引擎/纯函数/api 形状/端到端/审稿回合＋目录漂移告警/互斥/写回渲染机判 ===');
    runPromptsChecks();
    runPersonaAssemblyChecks();
    await runPersonaAssemblyDumpChecks();
    runPureFunctionChecks();
    runRedundancyChecks();
    await runApiChecks();
    await runGenerationTimeoutChecks();
    await runPersonaE2EChecks();
    await runStoreChecks();
    await runPersonaReviewChecks();
    runHostLiveBindingChecks();
    await runPersonaWriteBackChecks();
    runShellHookChecks();
    if (failures.length > 0) {
        console.error(`[persona-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[persona-smoke] OK：全任务提示词引擎（Record 全键＋choice 17 模块红线/旧数组整键重建默认＋warn/两套 persona 默认/dump 按任务）、锚点目录与提示词的形状契约与跨源接线（策展清单行形·块名——叶名串；N 叶；/回退骨架行形/归属对两端落真实叶/条件叶成文位置·不占声明叶数·不进回退骨架/策展指令交代条件叶例外/definition 非空率 100%/机制挂载段在场/要求 6 归属处落真实键/归属优先级表整段＝catalog 渲染/叶边界段宏位/静态成文一叶一行·行首落真实块/排除半句跨叶互指落真实键/无「不装」半句的叶 0——提示词措辞面归 diff 评审不进机器锁）、yaml 纯函数（分块/围栏·起手词补回判据行形态化——目录现值首叶行正例与散言反例）＋档案叶级解析（叶层缩进取块内首叶·字段内联首叶/1 空格缩进叶不丢·单块与零叶档案按分类码报不可判定/宿主错误正文凑够两块形状闸放行·裸列表项与无主续行进无主行·未识别块与未识别叶分开计）＋确定性判据（列表承载叶与空值叶与契约占位排除/literal 必命中含靠标点表才成立的一对/反转版与语义改写零命中为预期/未识别块叶 0/归一两段分工机判·标点表逐条）、api 客户端形状（请求体两档/SSE 帧状态机/流内上游错误帧真实事故样本/error:null 反向守门/非流式错误帧）、端到端三段链（统一端点请求形状/curator→personaGen 引擎管线/流内错误帧去 prefill 重试＋轮内即学即用＋生成链不反写设置域/学习经组合根写穿设置域/已标记端点起手词摘除/重试仍失败不落标记＋错误 toast 在场/结果落地·策展回退可见——curator 拒答回退内置骨架·标记置位·三段照发）、审稿回合（任务头字面＝[任务：审稿并修订]/判据层零命中仍无条件发出三段且末段认得出审稿指令/指令并进 messages 并携带整份档案＋末条是 user 审稿指令且全请求零 assistant 模型轮（审稿轮不带起手词）/审稿轮 400 不触发去起手词重试·三段共 3 次请求·落降级态并保留首轮档案/整份修订落档·改后档案逐字＝只换真变叶的那一份·简报按块·叶点名真变叶/皮毛漂移还原·未涉重叶的归一同值变体不落档/多行列表叶修订·模型行区间整段移植＋缩进按两侧行首空白差值平移/响应为空降级·结果框仍是首轮内容·不弹错误/store 路径结果框是审稿后的那一份·修订后档案逐字在框内/审稿轮收尾抛错（非 400 族）只降级不外抛·真因带栈进运行日志/骨架漂移拒·模型删叶整轮回滚/零变化拒绝·说了要修订却零改动即回滚/新增完全同值组拒·修订撞出同值新组即回滚/空值改写拒绝·整档抄写漏值不得清空原档/无围栏整档回执落档·宽松剥围栏后仍走骨架与逐叶合并守卫/四态文案逐字·失败原因白名单恰三项·空结果框显未运行态）、目录漂移告警（warn 打在审稿轮收尾·载荷只有计数与符号名不带档案内文·机制挂载块的叶不进计数·零漂移时一条不打）、persona 组装（curator 管线/persona_gen 管线占位符全填、档案段正文零跨段引用「原则 N·要求 N·策展段」、正文「块名·叶名」全落真实键、叶边界段随本次 schema 收敛且行集＝字面量三行、整段逐字节＝收敛成文、模块开关闭环）、全量注入空桶、store 互斥与显式保存点、CHAT_CHANGED 会话感知（lastRun 清空＋开场白重置默认档）、人设写回渲染通道（建档 initPersona 恰一次＋personas/描述符双写落地/两分支各刷一次列表/覆盖选中人设刷描述框＋镜像同步/覆盖非选中人设走 setUserAvatar 静默切换且不碰描述框与镜像）、切聊天取消 in-flight 生成（互斥即刻复位＋结果不误写＋lastRun 清空/取消在运行日志落一条 persona 失败记录且无双记/切聊天落在世界书收集窗口内亦不写回旧会话 lastRun·请求不发出）、壳真钩子（人设 tab 描述符注册 onActivate 且只刷宿主派生快照·编辑现场不动）、写回保护（首次成功写回立基线故同值不打扰/宿主侧修改后需确认）');
}
