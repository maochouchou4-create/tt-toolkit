/**
 * 组装引擎（纯函数核心，统一单条模块管线）。
 *
 * 纯函数设计：宿主数据由 sources 层收集成 AssemblySources（普通数据
 * 对象）后传入——engine 不碰宿主 API，node 冒烟与浏览器共用同一条
 * 组装路径（dump 断言的可机判前提）。占位符替换全部确定性（{{user}}/
 * {{char}}/{{count}}/{{min_chars}}/{{max_chars}}——值由 sources 提供）。
 */

import type {
    AssemblyMessage,
    ChoiceInjectionSource,
    InjectionSource,
    ModuleTrace,
    PersonaInjectionSource,
    PromptModule,
    StoryDirection,
} from './types';
import { PERSONA_INJECTION_SOURCES } from './types';

/** 聊天历史条目（原始 user/assistant 楼层；<current_scene> 包裹在引擎内做）。 */
export interface HistoryEntry {
    role: 'user' | 'assistant';
    content: string;
}

/**
 * 一次组装的上下文供给（宿主数据由 sources 层收集；node 冒烟可注入
 * 测试数据走同一引擎）。
 */
export interface AssemblySources {
    persona: string;
    charDescription: string;
    charPersonality: string;
    charScenario: string;
    charName: string;
    userName: string;
    worldInfoBefore: string;
    worldInfoAfter: string;
    /** 深度≥3 的世界书深度条目（深、背景——注入历史之前） */
    worldInfoDepthBefore: string;
    /** depth≤2 的世界书深度条目（浅、贴近生成点——注入历史之后） */
    worldInfoDepthAfter: string;
    /** 原始历史（不含 <current_scene>——包裹在本引擎做，位置固定末条 AI 楼层） */
    history: HistoryEntry[];
    /** 剧情走向（null＝未设置——story_direction 模块按未启用处理） */
    storyDirection: StoryDirection | null;
    /** 自动搬入的宿主通用注入槽位（非空即带；顺序＝宿主 depth 升序＋key 字典序，见 sources 收集处） */
    externalSlots: Array<{ key: string; value: string }>;
    /** 柏宝书摘要文本（插件缺席/接口异常传 null） */
    baibaiSummary: string | null;
    /**
     * 池注入供给。null＝池整体未启用（pool_entries 模块按未启用
     * 处理）；条目由 generator 现场抽取后传入——prompts 层不回读
     * choice 域（单向供给，引擎保持纯函数）。
     */
    poolInjection: PoolInjectionSupply | null;
    /** 占位符值 */
    count: number;
    minChars: number;
    maxChars: number;
}

/**
 * 池注入供给形状。字段取 PoolEntry 的子集（结构兼容：PoolEntry
 * 可直接赋进来）——prompts 层只关心渲染所需的两个文本字段，不知道池的
 * id/weight/绑定概念，保持两层解耦。
 */
export interface PoolEntryLine {
    type: string;
    content: string;
}

export interface PoolInjectionSupply {
    /** 必发区（pinned，每轮必须在场的条目） */
    pinned: PoolEntryLine[];
    /** 候选区（加权抽取，数量可多于实际所需——菜单模式） */
    drawn: PoolEntryLine[];
}

export interface AssemblyResult {
    messages: AssemblyMessage[];
    trace: ModuleTrace[];
}

/**
 * persona 两任务（策展＋填充）的组装供给。与 AssemblySources
 * 平行的独立接口：persona 管线的注入面与 choice 完全不同（角色卡全量
 * 文本/世界书参考/用户请求/schema——不是 choice 的分段标签注入），共用
 * 一个接口会让两边互相背对方不需要的字段。收集由 persona 调用方完成
 * （宿主数据与任务运行态——策展 schema、用户请求都是运行时才知道的）。
 */
export interface PersonaAssemblySources {
    /** 世界书参考（XiTa 式围栏包装后的文本；空＝无世界书） */
    wiText: string;
    /** 角色卡全量信息（包装后；{{charInfo}} 占位符同源） */
    charInfo: string;
    /** 开场白参考（包装后；{{greetings}} 占位符同源） */
    greetings: string;
    /** 用户请求包装块（{{input}} 与 {{userRequirements}} 同源） */
    userRequest: string;
    /** 策展产出 schema（包装后；策展失败回退默认模板时仍非空） */
    curatedSchema: string;
    /** 占位符值（{{user}}/{{char}}） */
    userName: string;
    charName: string;
}

/** sources 联合的判别（AssemblySources 无 charInfo 字段——in 收窄可靠）。 */
function isPersonaSources(sources: AssemblySources | PersonaAssemblySources): sources is PersonaAssemblySources {
    return 'charInfo' in sources;
}

/** persona 注入源判别集合（单一真相源＝types 的 as const 数组，此处只派生）。 */
const PERSONA_SOURCES: ReadonlySet<string> = new Set<string>(PERSONA_INJECTION_SOURCES);

/** 类型谓词形态的判别（Set.has 本身不带收窄——组装分流两处守门共用）。 */
function isPersonaSource(source: InjectionSource): source is PersonaInjectionSource {
    return PERSONA_SOURCES.has(source);
}

/**
 * persona 文本模块占位符替换。fork 提示词正文的占位符键名是组装契约
 * （{{charInfo}}/{{greetings}}/{{template}}/{{input}}/{{userRequirements}}），
 * 原样保留——键名即管线接口，改名＝破坏模板兼容。
 */
function fillPersonaPlaceholders(content: string, sources: PersonaAssemblySources): string {
    return content
        .replaceAll('{{user}}', sources.userName || '用户')
        .replaceAll('{{char}}', sources.charName || '角色')
        .replaceAll('{{charInfo}}', sources.charInfo)
        .replaceAll('{{greetings}}', sources.greetings)
        .replaceAll('{{template}}', sources.curatedSchema)
        .replaceAll('{{input}}', sources.userRequest)
        .replaceAll('{{userRequirements}}', sources.userRequest);
}

/**
 * persona 注入源→内容解析。与 choice 的 resolveInjectContent 平行：内容
 * 已由调用方包装（XiTa 围栏/SYSTEM_OP 块），引擎不再包分段标签——persona
 * 提示词正文自带 <source_materials>/<target_schema> 结构，再包一层会双重
 * 嵌套。空内容＝模块跳过（trace 留痕）。
 */
function resolvePersonaInjectContent(
    source: string,
    sources: PersonaAssemblySources,
): { content: string; note: string } {
    switch (source) {
        case 'persona_wi':
            return sources.wiText.trim()
                ? { content: sources.wiText, note: '世界书参考' }
                : { content: '', note: '世界书参考为空' };
        // 角色卡信息/开场白/用户请求/策展 schema 四件不走注入源：
        // 数据面字段在 PersonaAssemblySources、占位符填充链独立存活。
        default:
            return { content: '', note: `未知 persona 注入源 ${source}` };
    }
}

/** 组装管线占位符替换（确定性：值全部来自 sources）。 */
function fillPlaceholders(content: string, sources: AssemblySources): string {
    return content
        .replaceAll('{{count}}', String(sources.count))
        .replaceAll('{{min_chars}}', String(sources.minChars))
        .replaceAll('{{max_chars}}', String(sources.maxChars))
        .replaceAll('{{user}}', sources.userName || '用户')
        .replaceAll('{{char}}', sources.charName || '角色');
}

const CURRENT_SCENE_OPEN = '<current_scene>\n';
const CURRENT_SCENE_CLOSE = '\n</current_scene>';

/**
 * 聊天历史消息化：末条 AI 楼层用 <current_scene> 包裹（实证有效的注意力
 * 锚定——长对话中模型能明确识别「当前场景」边界）。无 AI 楼层时回退
 * 包裹末条（空历史返回空数组）。
 */
export function historyToMessages(history: HistoryEntry[]): Array<{ role: 'user' | 'assistant'; content: string }> {
    const out = history.map(h => ({ role: h.role, content: h.content }));
    let lastAssistantIdx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].role === 'assistant') {
            lastAssistantIdx = i;
            break;
        }
    }
    if (out.length > 0) {
        const wrapIdx = lastAssistantIdx >= 0 ? lastAssistantIdx : out.length - 1;
        out[wrapIdx].content = `${CURRENT_SCENE_OPEN}${out[wrapIdx].content}${CURRENT_SCENE_CLOSE}`;
    }
    return out;
}

/** 注入源→内容解析（模块注入与否在此判定，trace 记录跳过原因）。 */
function resolveInjectContent(
    source: ChoiceInjectionSource,
    sources: AssemblySources,
): { content: string; note: string } {
    switch (source) {
        case 'persona':
            return sources.persona.trim()
                ? { content: wrapTag('persona', `以下是用户本人（{{user}}）的人物设定，是行为动机的依据：\n${sources.persona.trim()}`, sources), note: '' }
                : { content: '', note: '用户人设为空（宿主未设置 persona_description）' };
        case 'char_description':
            return sources.charDescription.trim()
                ? { content: wrapTag('character', `以下是角色（{{char}}）的设定描述：\n${sources.charDescription.trim()}`, sources), note: '' }
                : { content: '', note: '角色卡 description 为空' };
        case 'char_personality':
            return sources.charPersonality.trim()
                ? { content: wrapTag('personality', `角色（{{char}}）的性格：\n${sources.charPersonality.trim()}`, sources), note: '' }
                : { content: '', note: '角色卡 personality 为空' };
        case 'char_scenario':
            return sources.charScenario.trim()
                ? { content: wrapTag('scenario', `故事背景设定：\n${sources.charScenario.trim()}`, sources), note: '' }
                : { content: '', note: '角色卡 scenario 为空' };
        case 'world_info_before':
            return sources.worldInfoBefore.trim()
                ? { content: wrapTag('world_info', sources.worldInfoBefore.trim(), sources), note: '' }
                : { content: '', note: '世界书前插条目未激活（本桶为空）' };
        case 'world_info_after':
            return sources.worldInfoAfter.trim()
                ? { content: wrapTag('world_info', sources.worldInfoAfter.trim(), sources), note: '' }
                : { content: '', note: '世界书后插条目未激活（本桶为空）' };
        case 'wi_depth_before':
            return sources.worldInfoDepthBefore.trim()
                ? { content: wrapTag('world_info', sources.worldInfoDepthBefore.trim(), sources), note: '' }
                : { content: '', note: '无深度≥3 的世界书条目' };
        case 'wi_depth_after':
            return sources.worldInfoDepthAfter.trim()
                ? { content: wrapTag('world_info', sources.worldInfoDepthAfter.trim(), sources), note: '' }
                : { content: '', note: '无 depth≤2 的世界书条目' };
        case 'chat_history':
            // 不可达：chat_history 在 assembleMessages 提前展开为多条消息
            // （本函数返回单串表达不了多消息）——此分支只为 switch 穷尽性
            return { content: '', note: '聊天历史为空' };
        case 'story_direction': {
            // <direction> 段＝已应用预设正文＋自由文本拼接
            // （预设文本与自由文本同为走向指令，不做二级标注）；两者
            // 皆空＝模块按未启用处理（不注入、trace 留痕）
            const preset = sources.storyDirection?.presetText.trim() ?? '';
            const free = sources.storyDirection?.freeText.trim() ?? '';
            if (!preset && !free) return { content: '', note: '剧情走向未设置（不注入）' };
            const note = preset && free ? '预设＋自由文本' : preset ? '预设' : '自由文本';
            return { content: wrapTag('direction', [preset, free].filter(Boolean).join('\n'), sources), note };
        }
        case 'external_slot': {
            // 自动口径：sources 枚举宿主非空槽位全带，
            // 无配置门——空列表＝没有插件写入，段缺席不报错
            if (sources.externalSlots.length === 0) return { content: '', note: '无可用槽位（没有插件写入公共注入区）' };
            const filled = sources.externalSlots.filter(s => s.value.trim());
            if (filled.length === 0) return { content: '', note: '在场槽位内容全为空' };
            // 逐槽位标注：每段带槽位 key 前缀——dump/trace 的「逐项可见」
            // 落到槽位粒度（多槽位搬入时能核对各自内容是否在场）
            const blocks = filled.map(s => `[槽位 ${s.key}]\n${s.value.trim()}`);
            const keys = filled.map(s => s.key).join('、');
            return { content: wrapTag('external_memory', blocks.join('\n\n'), sources), note: `已搬入槽位：${keys}` };
        }
        case 'baibai':
            return sources.baibaiSummary && sources.baibaiSummary.trim()
                ? {
                      content: wrapTag(
                          'past_events',
                          // 引导句措辞自写（AFPL：fork 对此句有同义近句，不搬其表达）。
                          // 语义保留＝说明这段是旧剧情摘录＋用途（衔接前情）
                          `这段文字来自记忆插件，概括的是较早前发生、已不在当前上下文里的剧情。利用它可以衔接前情、避免与旧事件矛盾，但不要在选项里复述或引用它的原文：\n${sources.baibaiSummary.trim()}`,
                          sources,
                      ),
                      note: '',
                  }
                : { content: '', note: '柏宝书摘要不可用（插件缺席或未返回）' };
        case 'pool_entries': {
            // 分区呈现：pinned＝固定条目（固定纳入每轮选项），drawn＝候选
            // 菜单（多于所需，AI 按场景贴合挑选）——菜单模式语义写在提示
            // 词文本里，不是条目行自己标注；逐条可见（dump 验收靠它）。
            // pinned 无注入上限＝fork send_all 同款语义，保留。
            const pool = sources.poolInjection;
            if (!pool) return { content: '', note: '池未启用（无池数据）' };
            if (pool.pinned.length === 0 && pool.drawn.length === 0) {
                return { content: '', note: '本聊天池为空（无条目被引用或全部停用）' };
            }
            const parts: string[] = [];
            if (pool.pinned.length > 0) {
                // P2-1 修复（双复核）：pinned ≥ count 时与 core_rules/output_format
                // 的「恰好 {{count}} 条」互斥——此段显式声明覆盖语义（后注入
                // 的专项指令赢），数量约束以固定条目为准。{{count}} 由
                // wrapTag 的占位符填充统一替换。
                const overage = pool.pinned.length >= sources.count
                    ? `\n注意：固定条目数量已达到常规数量 {{count}} 条——本轮选项数量以固定条目为准，允许超过 {{count}} 条，不受数量规则限制。`
                    : '';
                parts.push(`【固定条目】以下每条是一个行动方向，固定纳入每轮选项（共 ${pool.pinned.length} 条）：${overage}\n${pool.pinned.map(renderPoolLine).join('\n')}`);
            }
            if (pool.drawn.length > 0) {
                parts.push(`【候选条目】以下是本轮抽出的候选行动方向，数量多于实际所需——按与当前剧情的贴合度挑选使用，不要求全用，未选中的不出现在选项里（共 ${pool.drawn.length} 条）：\n${pool.drawn.map(renderPoolLine).join('\n')}`);
            }
            const note = `固定 ${pool.pinned.length} 条、候选 ${pool.drawn.length} 条${pool.pinned.length >= sources.count ? '（固定条目已覆盖数量规则）' : ''}`;
            return { content: wrapTag('pool_entries', parts.join('\n\n'), sources), note };
        }
    }
}

/** 单条池条目渲染：`type：content`（空段省略——与池层 renderEntryLine 同构约定）。 */
function renderPoolLine(entry: PoolEntryLine): string {
    let line = entry.type.trim();
    const content = entry.content.trim();
    if (content) line += `：${content}`;
    return line;
}

/** 分段标签包裹（§2.3 制版原则：结构化分段标签）＋占位符填充。 */
function wrapTag(tag: string, body: string, sources: AssemblySources): string {
    return fillPlaceholders(`<${tag}>\n${body}\n</${tag}>`, sources);
}

/**
 * 组装消息数组（模块管线主入口；choice 与 persona 任务共用）。
 *
 * 消息序列规则：
 *   - 模块按 order 升序逐个求值；chat_history 展开为多条 user/assistant
 *     消息（角色由楼层来源决定，不随模块 role 走——历史角色语义属于
 *     对话本身）；其余模块产出单条 role 消息。
 *   - 相邻同 role 合并（system/assistant；user 不互相合并——聊天历史末
 *     条 user 与任务指令同为 user 时，合并会把「任务指令」混进历史正文，
 *     user 消息在提示词里是独立输入边界）。
 *   - persona sources 时走 persona 占位符/注入源；任务源与 sources 形态
 *     不匹配的模块跳过并留痕（手改存档才会出现，不做静默吞）。
 */
export function assembleMessages(
    modules: PromptModule[],
    sources: AssemblySources | PersonaAssemblySources,
): AssemblyResult {
    const personaMode = isPersonaSources(sources);
    const sorted = [...modules].sort((a, b) => a.order - b.order);
    const messages: AssemblyMessage[] = [];
    const trace: ModuleTrace[] = [];

    for (const mod of sorted) {
        if (!mod.enabled) {
            trace.push({ moduleId: mod.id, moduleName: mod.name, kind: mod.kind, source: mod.kind === 'inject' ? mod.source : undefined, injected: false, note: '模块已停用' });
            continue;
        }
        if (mod.kind === 'text') {
            const content = (personaMode
                ? fillPersonaPlaceholders(mod.content, sources)
                : fillPlaceholders(mod.content, sources)
            ).trim();
            if (!content) {
                trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'text', injected: false, note: '文本为空' });
                continue;
            }
            pushMessage(messages, { role: mod.role, content });
            trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'text', injected: true, note: '' });
            continue;
        }
        // inject 模块：persona 形态先分流（persona 源解析；choice 源无数据跳过）
        if (personaMode) {
            if (!isPersonaSource(mod.source)) {
                trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'inject', source: mod.source, injected: false, note: '该注入源属于选项生成任务（本次 persona 组装无此数据）' });
                continue;
            }
            const { content, note } = resolvePersonaInjectContent(mod.source, sources);
            if (!content.trim()) {
                trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'inject', source: mod.source, injected: false, note: note || '注入内容为空' });
                continue;
            }
            pushMessage(messages, { role: mod.role, content: content.trim() });
            trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'inject', source: mod.source, injected: true, note });
            continue;
        }
        if (isPersonaSource(mod.source)) {
            trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'inject', source: mod.source, injected: false, note: '该注入源属于人设任务（选项生成组装无此数据）' });
            continue;
        }
        if (mod.source === 'chat_history') {
            if (sources.history.length === 0) {
                trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'inject', source: 'chat_history', injected: false, note: '聊天历史为空' });
                continue;
            }
            for (const m of historyToMessages(sources.history)) {
                pushMessage(messages, m);
            }
            trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'inject', source: 'chat_history', injected: true, note: `${sources.history.length} 条楼层，末条 AI 楼层已用 <current_scene> 包裹` });
            continue;
        }
        const { content, note } = resolveInjectContent(mod.source, sources);
        if (!content.trim()) {
            trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'inject', source: mod.source, injected: false, note: note || '注入内容为空' });
            continue;
        }
        // 注入成功的 trace 保留 resolve 给的 note（如 external_slot 的
        // 逐槽位清单）——「逐项可见」的粒度与注入内容一致，不降级为空注记
        pushMessage(messages, { role: mod.role, content: content.trim() });
        trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'inject', source: mod.source, injected: true, note });
    }

    return { messages, trace };
}

/** 相邻同 role 合并（user 除外，理由见 assembleMessages 注释）。 */
function pushMessage(messages: AssemblyMessage[], message: AssemblyMessage): void {
    const last = messages[messages.length - 1];
    if (last && last.role === message.role && message.role !== 'user') {
        last.content = `${last.content}\n\n${message.content}`;
    } else {
        messages.push({ ...message });
    }
}
