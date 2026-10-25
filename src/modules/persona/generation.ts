/**
 * PersonaWeaver fork 生成链：首次生成三段（curator 策展 schema →
 * personaGen 按 schema 填充 → 档案整份复核）。提示词模板与模块
 * 管线在统一提示词引擎（src/prompts——按任务键取配置，assemble＋占位
 * 符填充＋trace/dump 一致可观测），本文件只承载任务上下文收集与调用链。
 *
 * MODIFICATIONS（相对上游 fork）：
 * - Anthropic 原生分支整体退役（只保留 OpenAI 兼容形态）。
 * - 主 API（宿主生成路由）与独立 API（直连 Bearer fetch）
 *   两条通道合一，走统一端点表＋共享请求客户端。
 * - 字符串拼接组装退役——消息组装走引擎管线（persona 两任务
 *   键的模块与模板在代码默认模板内置）。
 * - DOM 读值链（getIndepTimeoutSec/getIndepStreamEnabled）退役：调用面只剩
 *   任务路由（GenerationApiConfig）。
 * - setGenProgress 直写 jQuery 按钮退役：onProgress 回调由 store 接管。
 * - toastr.info(prefill 重试) 退役：onPrefillRetry 回调归调用方 toast。
 * - collectContextData 的 DOM 勾选读取与「UI 勾选 → 存储域已存选择 →
 *   enabled 兜底」三级取条目整体退役：世界书改全量注入（绑定书全集条目
 *   拼接，无视任何条目规则），勾选/钉选域已随域形状删除。
 * - yieldToBrowser(requestAnimationFrame) 退役：Vue 渲染不靠逐书让帧。
 * - 宿主导入一律经 host 层（check-imports 纪律）：getCharacterName /
 *   getUserDisplayName / 世界书通道都从 '@/host' 进；预设影响不走 host
 *   预设解析（任务级预设已退役）——破限注入走 apis/preset-inject 传输层
 *   前缀；模型请求走 '@/modules/apis/client'（@sillytavern 导入面只在 src/host/）。
 */

import { getCharacterInfoText, getCharacterName, getUserDisplayName, getContextWorldBooks, getWorldBookEntries } from '@/host';
import { isBlankResponseContent, type GenerateMessage } from '@/modules/apis/client';
import { resolveJailbreakMessages } from '@/modules/apis/preset-inject';
import {
    assembleMessages,
    assemblePersonaReviewMessages,
    renderDump,
    DEFAULT_PROMPT_CONFIGS,
    type ModuleTrace,
    type PersonaAssemblySources,
    type TaskKey,
} from '@/prompts';
import { DEFAULT_TEMPLATES } from './prompts';
import { PersonaRunCancelled, requestOnce, type GenerationApiConfig, type RequestOnceParams } from './generation-request';
import {
    PREFILL_FENCE,
    PREFILL_SCHEMA,
    stripYamlFence,
    wrapAsXiTaReference,
    wrapInputForSafety,
} from './generation-wrap';
import { applyReviewVerdict, ReviewUnusableError, type ReviewBrief } from './review';
import { analyzeCatalogDrift } from './redundancy';
import { checkProfileShape, isSchemaSkeleton, parseYamlToBlocks } from './yaml';
import { TEXT } from './strings';
import { PERSONA_BLOCK_CATALOG, isSkeletonLeaf } from '@/modules/persona/catalog';
import { createTtlog } from '@/host/ttlog';

// 调用面与围栏面的公开面经此转出：消费方（store、排障注册处与冒烟）认的
// 是「生成链」这一个模块名，拆开后外部 import 面不变。
export { PersonaRunCancelled, type GenerationApiConfig, stripYamlFence };

const log = createTtlog('modules/persona/generation');

/**
 * 回退骨架（目录骨架标记的推导物）＋出厂自断言：它必须自身是一份可解析
 * 的骨架，且每个块键、每个叶键都在策展目录里。策展失败时链路由这份骨架
 * 兜底，骨架坏了却照发＝用户拿到一份结构错的档案且全程无报错；自断言把
 * 这层拦在出厂，不推给冒烟去发现。
 */
const SKELETON_FALLBACK = ((): string => {
    const skeleton = DEFAULT_TEMPLATES.user;
    const blocks = parseYamlToBlocks(skeleton);
    const catalogLeaves = new Map(
        PERSONA_BLOCK_CATALOG.map(b => [b.name, new Set(b.leaves.filter(isSkeletonLeaf).map(l => l.name))]),
    );
    const outside = [...blocks].flatMap(([block, body]) => {
        const known = catalogLeaves.get(block);
        const keys = (body.match(/^\s+(\S+):/gm) ?? []).map(k => k.trim().replace(/:$/, ''));
        if (!known) return [`块「${block}」不在目录里`];
        // 双向：解出来的键在目录里，且目录里该块标了骨架的叶一个不少地解了出来。
        // 只判前者时，键行正则切不出的叶（名字带 -／：）会整行丢掉、断言照样绿，
        // 而那正是骨架缺叶——模型拿到的是一份比目录少的档案，全程无报错。
        const missing = keys.length !== known.size
            ? [`块「${block}」解出 ${keys.length} 键 ≠ 目录骨架叶 ${known.size} 个`]
            : [];
        return [...missing, ...keys.filter(k => !known.has(k)).map(k => `叶「${block}·${k}」不在目录里`)];
    });
    if (!isSchemaSkeleton(skeleton) || blocks.size === 0 || outside.length > 0) {
        throw new Error(`回退骨架自断言未过：${outside.join('、') || '骨架不可解析或无块'}`);
    }
    return skeleton;
})();

/**
 * 世界书上下文收集（全量注入，已拍板无截断机制）：当前会话绑定书全集
 * （getContextWorldBooks 四绑定面）逐书全量条目拼接 `[DB:书名] content`
 * ——无视条目的 enabled/关键词触发等一切规则（getWorldBookEntries 本就
 * 不滤 disabled，返回前内部消化单书装载失败返回空表，天然不阻断）。
 */
export async function collectWorldInfoContext(): Promise<string> {
    const wiContent: string[] = [];
    for (const bookName of getContextWorldBooks()) {
        const entries = await getWorldBookEntries(bookName);
        for (const entry of entries) {
            wiContent.push(`[DB:${bookName}] ${entry.content}`);
        }
    }
    return wiContent.join('\n\n');
}

/**
 * persona 侧的任务键（收窄掉 choice）：本模块只组装/导出 persona 两段，
 * 放 choice 在这里是给「恒不可达的分支」留位置——键写进签名后编译器就会
 * 把误接挡住，那段抛错守卫随之没有存在面。
 */
type PersonaTaskKey = Exclude<TaskKey, 'choice'>;

/**
 * persona 任务消息组装（引擎管线）：按任务键取默认模板（任务键无编辑面，
 * 生效的就是 DEFAULT_PROMPT_CONFIGS 这一套），assemble＋占位符填充＋trace
 * 一条龙。返回值含 trace 供调用侧观测。
 */
function assemblePersonaMessages(task: PersonaTaskKey, sources: PersonaAssemblySources): { messages: GenerateMessage[]; trace: ModuleTrace[] } {
    const config = DEFAULT_PROMPT_CONFIGS[task];
    const result = assembleMessages(config.modules, sources);
    return { messages: result.messages, trace: result.trace };
}

export interface RunGenerationConfig extends GenerationApiConfig {
    request: string;
    wiText: string;
    greetingsText: string;
    onPrefillRetry?: () => void;
    /**
     * 去 prefill 重试成功后的「端点不收 prefill」事件处置（必填＝不设默认
     * no-op：能力记忆落档与用户提示都是跨域副作用，漏接＝能力永不再学且
     * 用户无感知；必填把漏接挡在编译期）。
     */
    onPrefillUnsupported: () => void;
    /** 段边界进度文案（「策展模板中…」/「生成中…」；store 接管按钮态）。 */
    onProgress?: (label: string) => void;
    /** 外部取消信号（「停止」按钮；贯穿三轮）。 */
    signal?: AbortSignal;
}

interface ReviewRoundParams {
    config: GenerationApiConfig;
    /** 档案段已组装好的消息与 trace（复核轮接在它后面，不重跑那一段）。 */
    assembled: { messages: GenerateMessage[]; trace: ModuleTrace[] };
    /** 档案段的组装供给（复用同一份策展产出；只多带 profile）。 */
    sources: PersonaAssemblySources;
    /** 首轮档案：兜底值 ＋ 指令里 {{profile}} 的值。 */
    profile: string;
    onProgress?: (label: string) => void;
    signal?: AbortSignal;
}

/** 生成链的结果：最终档案 ＋ 复核简报（两者分家——见 ReviewBrief 的注释）。 */
export interface GenerationResult {
    profile: string;
    review: ReviewBrief;
}

/**
 * 复核回合（AI 调用 3）：档案段成功后**无条件**再发一轮，判定权全给模型。
 *
 * 钉死的约束在这里落地：
 *   - **只重发档案段**：复用同一份策展产出，不重跑策展——重跑会让 schema 变，
 *     指令里点名的「块.叶」随之可能不存在；
 *   - **本轮不带 prefill**：prefill 锚的是「这一轮要什么输出格式」，不是本次
 *     会话的常量。档案段要 ` ```yaml ` ＋块名的 YAML 续写；复核轮的输出是
 *     两态——没重复只回「无重复」四字，有改写才回整份档案。给复核轮续一段
 *     YAML 围栏起手，等于把模型钉死在「接着写档案」那一态上：「无重复」四字
 *     被起手词压掉，没重复的档案也得整份重抄一遍。**不带起手词是这一轮的
 *     决定，与端点能力无关**：端点不支持 prefill 那件事由能力记忆链承担
 *     （那两条 YAML 轮仍带起手词、仍走 400 去-prefill 重试），两条路径不混；
 *   - **指令并进 `messages`**：它是本轮最后一条（user）消息。顺带一条——
 *     requestOnce 的 400 去-prefill 重发用的正是同一份 messages，指令若拼进
 *     promptArray 就会随 promptArray 一起被重置掉；
 *   - **首轮结果是兜底值**：空白／超时／网络错／回复不可用，一律返回首轮档案
 *     ＋ 对应降级简报。用户等满一轮复核的代价已经付了，换来的必须是一份档案
 *     （这一保证是 settleReviewRound 的结构义务，见它的注释）；
 *   - **取消照旧上抛**：那是用户中止整轮，不是「复核没跑完」——结果框保持原值
 *     是取消通道的既有契约。
 */
async function reviewProfile(params: ReviewRoundParams): Promise<GenerationResult> {
    const { profile } = params;
    // 入口形状闸（纯诊断：它只决定脚本侧那道「无新增完全同值」本轮跑不跑，
    // **不决定这一轮发不发**——拿形状判定当复核的闸门＝把语义检出率为零的判据层
    // 重新接成触发器，redundancy.ts 的文件头明确禁这件事）。缺席要留痕。
    // 「形状能不能判」由落地层自己从这份档案派生（applyReviewVerdict 内部扫
    // before），这里只把 code 打进日志：让调用方送一份可能来自别的文本的形状
    // 进来，校验就会读着一份不相干的形状放行或翻红。
    const shape = checkProfileShape(profile);
    if (!shape.ok) {
        log.warn('复核入口：档案形状不可判定，脚本侧同值校验本轮不跑（复核照发）', {
            code: shape.code,
            topLevelBlocks: shape.topLevelBlocks,
            leafCount: shape.leafCount,
        });
    }

    params.onProgress?.('查重复核中…');
    const result = await settleReviewRound(params);
    // 目录漂移的唯一出口（挂在复核轮收尾而不是改写分支上：漂移与「有没有重复」
    // 「这一轮改没改」三件正交，挂在改写分支上则模型回「无重复」那条最常见的路
    // 没有告警——而那条路恰恰最需要它，没人改写就没人会发现目录漂了）。
    // 三条出口（改写后／判定无重复／降级回退首轮档案）都过这里，一次生成一条：
    // 降级也报，那条路的档案照样会被人存下来用，漂移照样存在。
    warnCatalogDrift(result.profile);
    return result;
}

/**
 * 复核轮本体：**组装指令 → 发请求 → 解析落地**，三步都在同一个降级 try 里。
 *
 * 收口在一个 try 是结构保证而非风格选择：这三步里任何一处抛出，若由调用方各自
 * try，用户看到的就是「档案已经生成成功，却只得到一条错误提示」——首轮档案明明
 * 就在手上，而它只在 store 的成功分支里被赋值，降级与否全看这里有没有兜住。
 * 换句话说，「复核怎么失败都有一份档案」是这一层的义务，不该靠每个 throw 点
 * 自觉。诊断（目录漂移 warn）在 try 之外，且它的入口不抛错，不参与成败。
 *
 * 异常分两类处理，界线是**异常是不是「模型那一份回执不合契约」**：
 *   - `ReviewUnusableError`：契约内唯一那型，降级文案说「解析不了复核结果」是
 *     对用户说的真话。
 *   - 其余（超时、网络、以及本模块自己的缺陷）：文案只有三档白名单，这一支落到
 *     「请求失败」那一档——对用户成立的是「这一轮没跑完，上一版结果还在」，而
 *     真正的原因连栈一起进 `log.error`。异常**不外抛**：档案已经生成成功，让它
 *     顶掉结果框是把一个可选环节的失败升级成整轮失败。
 *   - 取消照旧上抛（用户中止整轮，不是「复核没跑完」，取消通道的既有契约）。
 */
async function settleReviewRound(params: ReviewRoundParams): Promise<GenerationResult> {
    const { profile } = params;
    try {
        const reviewAssembled = assemblePersonaReviewMessages(params.sources, profile);
        const raw = await requestOnce({
            config: params.config,
            // 刻意不带起手词（见 reviewProfile 的注释）；也因此本轮不可能走
            // 400 去-prefill 重试——没有起手词可去，重试只会把同一条请求原样再发一遍。
            messages: [...params.assembled.messages, ...reviewAssembled.messages],
            trace: [...params.assembled.trace, ...reviewAssembled.trace],
            label: 'personaReview',
            signal: params.signal,
        });
        if (isBlankResponseContent(raw)) {
            log.warn('复核轮响应为空，保留首轮结果');
            return { profile, review: { kind: 'failed', reason: TEXT.REVIEW_BRIEF.FAILURE_REASON.EMPTY } };
        }
        const outcome = applyReviewVerdict(profile, raw);
        if (outcome.kind === 'none') return { profile, review: { kind: 'none' } };
        log.info(`复核改写落档案：${outcome.changedKeys.join('、')}`);
        return { profile: outcome.text, review: { kind: 'rewritten', changedKeys: outcome.changedKeys } };
    } catch (err) {
        if (err instanceof PersonaRunCancelled) throw err;
        if (err instanceof ReviewUnusableError) {
            log.warn('复核结果不可用，回滚到首轮结果', err);
            return { profile, review: { kind: 'failed', reason: TEXT.REVIEW_BRIEF.FAILURE_REASON.UNUSABLE } };
        }
        log.error('复核轮未能完成，保留首轮结果（异常带栈，不并入用户可见文案）', err);
        return { profile, review: { kind: 'failed', reason: TEXT.REVIEW_BRIEF.FAILURE_REASON.REQUEST } };
    }
}

/**
 * 目录漂移体检告警：唯一的出口是这条 warn，返回 void —— 诊断不参与成败。
 *
 * 触发只看 `catalogDriftLeaves`——「目录里存在的块下，模型写出了目录没有的叶」，
 * 处置是改目录（catalog.ts）不是改档案。`unrecognizedBlocks` 与机制挂载块的叶
 * 不计入触发：机制挂载块按该世界的原生词汇命名，那份报告的字段注释写明「永远
 * 不必补叶」，把它们算进来等于每份挂机制块的正常档案都喊一次漂移。两个计数
 * 仍打进载荷作上下文。
 *
 * 载荷只有计数与符号名，**不带档案内文**：运行日志会被用户翻，档案正文是私事。
 *
 * 入口是判据层那条**不抛错的窄通道**（analyzeCatalogDrift）：形状不可判定时它
 * 照样返回一个报告而不是抛——所以这里不需要 try，也不可能把诊断变成失败源。
 */
function warnCatalogDrift(profile: string): void {
    const report = analyzeCatalogDrift(profile);
    if (report.catalogDriftLeaves.length === 0) return;
    log.warn('目录漂移体检：目录内块里写出了目录没有的叶（查 catalog.ts 补叶，不是改档案）', {
        catalogDriftLeaves: report.catalogDriftLeaves.length,
        mechanismBlocksOutsideCatalog: report.mechanismBlocksOutsideCatalog,
        unrecognizedLeavesTotal: report.unrecognizedLeavesTotal,
        symbol: 'analyzeCatalogDrift(...).catalogDriftLeaves（src/modules/persona/redundancy.ts）',
    });
}

/**
 * 生成主链（旧 runGeneration 平移）：策展（schema，fail-soft 回退默认
 * 模板）→ personaGen 填充 → 整份复核（无条件一轮）。返回最终档案与复核
 * 简报；**空输出抛「API 返回为空」——那是档案段的事**，复核段不抛（见
 * reviewProfile）。
 */
export async function runGeneration(config: RunGenerationConfig): Promise<GenerationResult> {
    const charName = getCharacterName() || 'Char';
    const currentName = getUserDisplayName();

    const rawCharInfo = getCharacterInfoText();

    const wrappedCharInfo = wrapAsXiTaReference(rawCharInfo, `Entity Profile: ${charName}`);
    const wrappedWi = wrapAsXiTaReference(config.wiText || '', 'Global State Variables');
    const wrappedGreetings = wrapAsXiTaReference(config.greetingsText || '', 'Init Sequence');
    const wrappedInput = wrapInputForSafety(config.request || '');

    // 策展产出 schema（纯键），起手词只需围栏头；档案段起手词从目标结构
    // 首键派生——schema 由策展动态产出，不保证首块是基本信息，硬编码会
    // 逼模型续写出 schema 外的块。
    const profilePrefillFor = (structureText: string): string => {
        // 首键取不到（结构不可解析）时退到回退骨架的首键：骨架由目录推导，
        // 首块会随目录变，这里再写死块名就是把第二份真相源搬进起手词。
        const firstKey = parseYamlToBlocks(structureText || '').keys().next().value
            ?? parseYamlToBlocks(SKELETON_FALLBACK).keys().next().value;
        return PREFILL_FENCE + '\n' + firstKey + ':';
    };
    // 端点能力记忆门控：已标记不支持 prefill 的端点直接不发起手词（格式
    // 稳定性的代价换可用性；标记由去 prefill 重试成功自动落下，不自动翻回）。
    // 活值而非入口快照：学习发生在策展段的重试里，档案段必须接着不带起手词
    // ——入口快照会让同一轮再吃一次 400、用户再看到一条一样的提示。
    let noPrefill = config.route.noPrefill;
    const onLearnedNoPrefill = (): void => {
        noPrefill = true;
        config.onPrefillUnsupported();
    };
    const prefillFor = (prefill: string): string => (noPrefill ? '' : prefill);
    /**
     * 起手词与它的处置者捆成一捆交给 requestOnce（见 RequestOnceParams.prefill）：
     * 本轮不带起手词时整捆缺席，而不是「带一个空串的起手词」。
     */
    const prefillBundleFor = (prefill: string): RequestOnceParams['prefill'] => {
        const content = prefillFor(prefill);
        return content ? { content, onUnsupported: onLearnedNoPrefill } : undefined;
    };

    const finalize = (rawText: string, prefillContent: string): string => {
        // 空白正文也算空（isBlankResponseContent 单点判据）：上游静默拦截
        // 常回纯空白，静默成功会让用户只看到空结果框——Fail Fast 抛错。
        if (isBlankResponseContent(rawText)) throw new Error('API 返回为空 (Empty Response)');
        return stripYamlFence(rawText, prefillContent);
    };

    // AI 调用 1：策展 Schema。空输出或剥围栏后不可解析 → 回退默认模板，链路不中断。
    // 任务上下文供给（引擎占位符/注入源消费面；策展段 curatedSchema 为空）。
    // 预设影响不走这里——统一走传输层破限注入（apis/preset-inject，每轮都带）。
    const baseSources: PersonaAssemblySources = {
        wiText: wrappedWi,
        charInfo: wrappedCharInfo,
        greetings: wrappedGreetings,
        userRequest: wrappedInput,
        curatedSchema: '',
        userName: currentName,
        charName,
    };
    const curateSchema = async (): Promise<string> => {
        const assembled = assemblePersonaMessages('persona_curator', baseSources);
        const raw = await requestOnce({
            config,
            messages: assembled.messages,
            trace: assembled.trace,
            prefill: prefillBundleFor(PREFILL_SCHEMA),
            label: 'curator',
            onPrefillRetry: config.onPrefillRetry,
            signal: config.signal,
        });
        const curated = raw ? stripYamlFence(raw, prefillFor(PREFILL_SCHEMA)) : '';
        if (!isSchemaSkeleton(curated)) {
            log.warn('策展输出为空或不可解析，回退默认模板', { curated });
            return SKELETON_FALLBACK;
        }
        return curated;
    };

    config.onProgress?.('策展模板中…');
    const schemaForGen = await curateSchema();
    config.onProgress?.('生成中…');

    const wrappedTags = wrapAsXiTaReference(schemaForGen, 'Schema Definition');
    const genSources: PersonaAssemblySources = { ...baseSources, curatedSchema: wrappedTags };
    const assembled = assemblePersonaMessages('persona_gen', genSources);

    // 档案段起手词从策展 schema 首键派生（curateSchema fail-soft 回退默认模板，恒非空）
    const profilePrefill = prefillFor(profilePrefillFor(schemaForGen));
    const raw = await requestOnce({
        config,
        messages: assembled.messages,
        trace: assembled.trace,
        prefill: prefillBundleFor(profilePrefillFor(schemaForGen)),
        label: 'personaGen',
        onPrefillRetry: config.onPrefillRetry,
        signal: config.signal,
    });

    // AI 调用 3：整份复核（无条件一轮；不带 prefill；失败降级，首轮档案兜底）。
    return reviewProfile({
        config,
        assembled,
        sources: genSources,
        profile: finalize(raw, profilePrefill),
        onProgress: config.onProgress,
        signal: config.signal,
    });
}

/**
 * persona 任务的观测 dump（__TT_TOOLKIT__.prompts.dump(task) 分派口）：宿主真实
 * 上下文（角色卡/开场白/世界书）＋空任务态——用户请求与策展 schema
 * 是运行时输入，dump 无从得知，占位符以空串呈现模板形状。与 choice 的
 * dump 同口径（消息段＝破限前缀＋组装序列，前缀经 apis/preset-inject 的
 * composeOutbound 同一实现；prefill 是每段请求的局部追加，不属组装产物，
 * 实发全文以运行日志为准）。
 */
export async function dumpPersonaTask(task: PersonaTaskKey): Promise<string> {
    const charName = getCharacterName() || '角色';
    const sources: PersonaAssemblySources = {
        wiText: wrapAsXiTaReference(
            await collectWorldInfoContext(),
            'Global State Variables',
        ),
        charInfo: wrapAsXiTaReference(getCharacterInfoText(), `Entity Profile: ${charName}`),
        greetings: '',
        userRequest: '',
        curatedSchema: '',
        userName: getUserDisplayName(),
        charName,
    };
    const assembled = assemblePersonaMessages(task, sources);
    return renderDump({ messages: assembled.messages, trace: assembled.trace }, undefined, resolveJailbreakMessages());
}
