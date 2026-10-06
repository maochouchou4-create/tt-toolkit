/**
 * 上下文源收集（宿主数据 → AssemblySources 纯数据对象）。
 *
 * 分层：engine 纯函数不碰宿主；本层做全部宿主读取（人设/角色卡/世界书
 * 激活/历史/外部注入/走向），产物交给 engine。node 冒烟下宿主数据为
 * 存根空值，同一收集路径照跑（dump 可机判的前提）。
 */
import {
    currentCharacters,
    currentThisChid,
    getChatHistory,
    getPersonaDescription,
    getTavernContext,
    listExtensionPromptSlots,
    runWorldInfoScan,
    substituteMacros,
} from '@/host';
import { getBaibaiSummary } from './external';
import type { AssemblySources, PoolInjectionSupply } from './engine';
import type { StoryDirection } from './types';

/** 世界书深度条目分界：depth≤2 归「浅」（历史后、贴近生成点），≥3 归「深」。 */
const WI_DEPTH_AFTER_MAXDEPTH = 2;

/** 世界书激活预算上限：独立旁路请求沿用大上下文估算，避免角色大书先耗尽预算（fork 实证同因）。 */
const WI_MAX_CONTEXT = 128000;

interface CharacterCardLike {
    name?: string;
    data?: {
        description?: string;
        personality?: string;
        scenario?: string;
        creator_notes?: string;
        extensions?: { depth_prompt?: { prompt?: string } };
    };
}

function currentCharacter(): CharacterCardLike | null {
    const idx = currentThisChid();
    if (typeof idx !== 'string' || idx === '') return null;
    const ch = currentCharacters()[Number(idx)] as CharacterCardLike | undefined;
    return ch ?? null;
}

/**
 * 收集一次组装所需的全部上下文。storyDirection 与 poolInjection 由调用方
 * 传入（chat 域/choice 域读取归 choice 侧管——组装参数与存储调度分离；
 * 池供给由 generator 现场抽取，本层只做纯收集不回读 choice 域）。
 */
export async function collectAssemblySources(params: {
    storyDirection: StoryDirection | null;
    contextRounds: number;
    count: number;
    minChars: number;
    maxChars: number;
    poolInjection?: PoolInjectionSupply | null;
}): Promise<AssemblySources> {
    const ch = currentCharacter();
    const card = ch?.data ?? {};
    const persona = getPersonaDescription();
    const history = getChatHistory(params.contextRounds);

    // 世界书扫描：chat 需倒序（最新在前，宿主契约）；喂已过滤隐藏楼层
    // 的正文——与主生成激活范围一致（隐藏楼层关键词不触发绿灯条目）。
    const chatStrings = [...history].reverse().map(h => h.content);
    let worldInfo = {
        worldInfoBefore: '',
        worldInfoAfter: '',
        worldInfoExamples: [] as string[],
        worldInfoDepth: [] as Array<{ depth: number; entries: string[] }>,
    };
    try {
        worldInfo = await runWorldInfoScan({
            chatStrings,
            maxContext: WI_MAX_CONTEXT,
            personaDescription: substituteMacros(persona),
            characterDescription: substituteMacros(String(card.description ?? '')),
            characterPersonality: substituteMacros(String(card.personality ?? '')),
            characterDepthPrompt: String(card.extensions?.depth_prompt?.prompt ?? ''),
            scenario: substituteMacros(String(card.scenario ?? '')),
            creatorNotes: String(card.creator_notes ?? ''),
        });
    } catch (e) {
        // 世界书失败不拖垮整次组装（人设/历史照发）；留痕排障
        console.error('[tt-toolkit][prompts] 世界书激活扫描失败（本次组装不含世界书）', e);
    }

    // 深度桶分组：同 depth 已由宿主合并为组；两组各自 depth 降序
    // （深者在前，D0 最贴近生成点），组间拼接
    const depthEntries = worldInfo.worldInfoDepth
        .map(d => ({ depth: d.depth, content: d.entries.filter(Boolean).join('\n') }))
        .filter(e => e.content.trim());
    const byDepthDesc = (a: { depth: number }, b: { depth: number }) => b.depth - a.depth;
    const depthBefore = depthEntries.filter(e => e.depth > WI_DEPTH_AFTER_MAXDEPTH).sort(byDepthDesc).map(e => e.content).join('\n\n');
    const depthAfter = depthEntries.filter(e => e.depth <= WI_DEPTH_AFTER_MAXDEPTH).sort(byDepthDesc).map(e => e.content).join('\n\n');

    // 外部注入搬运（全自动——无开关无勾选）。槽位
    // 枚举口径（宿主源码核实锚点，D:\code\repos\TauriTavern\src）：
    //   - openai.js:1484 populationInjectionPrompts：depth 升序循环
    //     （i=0..maxDepth，depth 0 最贴近生成点）——自动搬入的排序对齐
    //     该顺序：depth 升序在前＝浅位先出。
    //   - openai.js:1547-1549 getPromptAssemblyExtensionPrompt 与
    //     script.js:4115 getExtensionPrompt：同 depth 内槽位 key 字典序
    //     （Object.keys(...).sort()）。
    //   - script.js:4040-4045 getAllExtensionPrompts：空白 value 跳过
    //     ——非空即带的「非空」＝trim 后有内容。
    // 兼容不了（context 缺席/表空）→ 空列表，引擎段缺席不报错。每次
    // 组装现取（不启动时缓存，插件可能后加载/切卡重建）。
    // 柏宝书：在场即带（auto 口径）——getBaibaiSummary 插件缺席/接口
    // 异常返回 null（external.ts 取数纪律），引擎按不注入处理。
    const extSlots = listExtensionPromptSlots()
        .filter(s => s.value.trim() !== '')
        .sort((a, b) => a.depth - b.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map(s => ({ key: s.key, value: substituteMacros(s.value) }));
    const baibai = getBaibaiSummary();

    return {
        persona: substituteMacros(persona),
        charDescription: substituteMacros(String(card.description ?? '')),
        charPersonality: substituteMacros(String(card.personality ?? '')),
        charScenario: substituteMacros(String(card.scenario ?? '')),
        charName: String(ch?.name ?? ''),
        // 名字双通道：{{user}}/{{char}} 在注入内容里已由 substituteMacros
        // 展开；此处提供真实名给 engine 兜底（分段标签包裹文字与文本模块
        // 的 {{user}}/{{char}} 占位符）。context 缺席（node 冒烟）时为空串
        // → engine 兜底「用户/角色」。
        userName: String((getTavernContext() as { name1?: unknown } | null)?.name1 ?? ''),
        worldInfoBefore: substituteMacros(worldInfo.worldInfoBefore),
        worldInfoAfter: substituteMacros(worldInfo.worldInfoAfter),
        worldInfoDepthBefore: substituteMacros(depthBefore),
        worldInfoDepthAfter: substituteMacros(depthAfter),
        history,
        storyDirection: params.storyDirection,
        externalSlots: extSlots,
        baibaiSummary: baibai,
        // 池供给：调用方（generator）现场抽取后直传——null＝池未启用
        poolInjection: params.poolInjection ?? null,
        count: params.count,
        minChars: params.minChars,
        maxChars: params.maxChars,
    };
}
