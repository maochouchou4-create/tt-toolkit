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
    InjectModule,
    ModuleTrace,
    PersonaInjectionSource,
    PromptModule,
    TextModule,
} from './types';
import { PERSONA_INJECTION_SOURCES } from './types';
import { definitionRowKeysFromSchema, renderCatalogDefinitions } from '@/modules/persona/catalog';

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
    /** 自动搬入的宿主通用注入槽位（非空即带；顺序＝宿主 depth 升序＋key 字典序，见 sources 收集处） */
    externalSlots: Array<{ key: string; value: string }>;
    /**
     * 池注入供给。null＝池整体未启用（pool_entries 模块按未启用
     * 处理）；候选风格名由 generator 现场抽取后传入——prompts 层不回读
     * choice 域（单向供给，引擎保持纯函数）。
     */
    poolInjection: PoolInjectionSupply | null;
    /** 占位符值 */
    count: number;
    minChars: number;
    maxChars: number;
}

/**
 * 池注入供给形状：本轮抽中的候选风格名（纯随机不放回，候选可能多于
 * 实际所需——菜单模式）。generator 现场抽取后传入，prompts 层只渲染，
 * 不知道池的 id 等概念，保持两层解耦。
 */
export interface PoolInjectionSupply {
    /** 候选风格名（可多于实际所需，AI 按贴合度挑选） */
    drawn: string[];
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

/** 类型谓词形态的判别（Set.has 本身不带收窄——组装分流多处守门共用）。 */
function isPersonaSource(source: InjectionSource): source is PersonaInjectionSource {
    return PERSONA_SOURCES.has(source);
}

/**
 * persona 文本模块占位符替换。fork 提示词正文的占位符键名是组装契约
 * （{{charInfo}}/{{greetings}}/{{template}}/{{input}}/{{userRequirements}}），
 * 原样保留——键名即管线接口，改名＝破坏模板兼容。
 *
 * {{catalog_definitions}} 是本仓自有的第二个档案段占位符，与 fork 那批不同：
 * 它的值本次请求现算（按 sources.curatedSchema 收敛出该守边界的叶），落不进
 * 默认模板字面量——模板里放全量行时，每次请求都要为本次 schema 里不可能
 * 出现的键白付一遍边界文字，且这份负担随目录增长只增不减。
 *
 * {{profile}}（审稿指令用）**不在这条链上**：它是那一轮独有的数据，走审稿指令
 * 模块自己的填充（assemblePersonaReviewMessages，在组装之后填）。放在通用链里
 * 的代价是本链的所有轮次都要带一个空值参与替换——用户在策展/档案轮自己写的
 * `{{profile}}` 字面量会被静默抹成空串，而那两轮本来就不该认识这个键。
 */
function fillPersonaPlaceholders(content: string, sources: PersonaAssemblySources): string {
    return content
        .replaceAll('{{user}}', sources.userName || '用户')
        .replaceAll('{{char}}', sources.charName || '角色')
        .replaceAll('{{charInfo}}', sources.charInfo)
        .replaceAll('{{greetings}}', sources.greetings)
        .replaceAll('{{template}}', sources.curatedSchema)
        .replaceAll('{{catalog_definitions}}', renderCatalogDefinitions(definitionRowKeysFromSchema(sources.curatedSchema)))
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
        case 'pool_entries': {
            // 菜单模式：候选风格名单（多于所需，AI 按场面贴合挑选 count 个）
            // ——风格决定每条选项的姿态与笔调，选项正文由模型按风格轴现场写；
            // 逐名编号可见（dump 验收靠它）。
            const pool = sources.poolInjection;
            if (!pool) return { content: '', note: '池未启用（无池数据）' };
            if (pool.drawn.length === 0) {
                return { content: '', note: '本聊天池为空' };
            }
            const body = `【候选风格】本轮抽到的风格轴（共 ${pool.drawn.length} 个，候选可能多于实际所需）——按与当前场面的贴合度挑选 {{count}} 个使用，每条选项各用一个风格、不重复，未选中的不出现：\n${pool.drawn.map((name, i) => `${i + 1}. ${name}`).join('\n')}`;
            return { content: wrapTag('pool_entries', body, sources), note: `候选风格 ${pool.drawn.length} 个` };
        }
        // 防御分支：注入源类型新增而未接 case 时按「跳过留痕、不静默吞」
        // 纪律空段留痕，不让解构炸在组装中段（形态对齐 persona 解析的 default）
        default:
            return { content: '', note: `未知注入源 ${String(source)}` };
    }
}

/** 分段标签包裹（§2.3 制版原则：结构化分段标签）＋占位符填充。 */
function wrapTag(tag: string, body: string, sources: AssemblySources): string {
    return fillPlaceholders(`<${tag}>\n${body}\n</${tag}>`, sources);
}

/**
 * 单模块求值的产出计划（消息序列 ＋ 留痕注记）。组装主循环只认这一个
 * 形态——任务族的差异全部封在族实现内，循环本身不认识 choice/persona。
 */
interface ModulePlan {
    /** 本模块是否注入（false＝停用、跨族数据、或解析出空内容）。 */
    injected: boolean;
    /** 留痕注记：跳过原因或解析注记（dump 的逐项可见粒度即此）。 */
    note: string;
    /** 产出的消息（聊天历史展开为多条；跳过为空）。 */
    messages: AssemblyMessage[];
}

/** 跳过的模块（不产消息，只留痕）。 */
function skipped(note: string): ModulePlan {
    return { injected: false, note, messages: [] };
}

/** 产出单条消息的模块（内容由引擎统一 trim：注入文本的空白不进管线）。 */
function emitted(mod: PromptModule, content: string, note: string): ModulePlan {
    return { injected: true, note, messages: [{ role: mod.role, content: content.trim() }] };
}

/** 解析器结果→计划（空内容与空注记的收口单点，两个族的解析器同此约定）。 */
function resolved(mod: PromptModule, result: { content: string; note: string }): ModulePlan {
    return result.content.trim()
        ? emitted(mod, result.content, result.note)
        : skipped(result.note || '注入内容为空');
}

/** 文本模块的计划（占位符填充链由所属族给；填完为空即跳过）。 */
function planText(mod: TextModule, family: AssemblyFamily): ModulePlan {
    const content = family.fillText(mod.content);
    return content.trim() ? emitted(mod, content, '') : skipped('文本为空');
}

/**
 * 组装族：两族的占位符键名、注入源集合、聊天历史处理三处都不同，合成
 * 一套只会让每处都挂「若属另一族」的守卫。族＝这三处差异的唯一归属地。
 */
interface AssemblyFamily {
    /** 文本模块的占位符填充。 */
    fillText(content: string): string;
    /** inject 模块的产出计划。 */
    planInject(mod: InjectModule): ModulePlan;
}

/** choice 族：注入源为非 persona 的全部源，含聊天历史展开。 */
function choiceFamily(sources: AssemblySources): AssemblyFamily {
    return {
        fillText: content => fillPlaceholders(content, sources),
        planInject(mod) {
            if (isPersonaSource(mod.source)) {
                return skipped('该注入源属于人设任务（选项生成组装无此数据）');
            }
            if (mod.source === 'chat_history') {
                if (sources.history.length === 0) return skipped('聊天历史为空');
                return {
                    injected: true,
                    note: `${sources.history.length} 条楼层，末条 AI 楼层已用 <current_scene> 包裹`,
                    messages: historyToMessages(sources.history),
                };
            }
            // 注入成功的 trace 保留 resolve 给的 note（如 external_slot 的
            // 逐槽位清单）——「逐项可见」的粒度与注入内容一致，不降级为空注记
            return resolved(mod, resolveInjectContent(mod.source, sources));
        },
    };
}

/** persona 族：注入源只有 persona_wi，其余源在本族无数据即留痕跳过。 */
function personaFamily(sources: PersonaAssemblySources): AssemblyFamily {
    return {
        fillText: content => fillPersonaPlaceholders(content, sources),
        planInject(mod) {
            if (!isPersonaSource(mod.source)) {
                return skipped('该注入源属于其他生成任务（本次 persona 组装无此数据）');
            }
            return resolved(mod, resolvePersonaInjectContent(mod.source, sources));
        },
    };
}

/** 分流单点：sources 判别谓词→组装族（族外不再出现任务族分支）。 */
function familyOf(sources: AssemblySources | PersonaAssemblySources): AssemblyFamily {
    return isPersonaSources(sources) ? personaFamily(sources) : choiceFamily(sources);
}

/**
 * 组装消息数组（模块管线主入口；choice/persona 任务共用）。
 *
 * 消息序列规则：
 *   - 模块按 order 升序逐个求值；chat_history 展开为多条 user/assistant
 *     消息（角色由楼层来源决定，不随模块 role 走——历史角色语义属于
 *     对话本身）；其余模块产出单条 role 消息。
 *   - 相邻同 role 合并（system/assistant；user 不互相合并——聊天历史末
 *     条 user 与任务指令同为 user 时，合并会把「任务指令」混进历史正文，
 *     user 消息在提示词里是独立输入边界）。
 *   - 主循环只做「求值 → 产消息 → 留痕」三件事；族差异经 familyOf 单点
 *     分派。任务源与 sources 形态不匹配的模块跳过后留痕（代码装配错误——
 *     新增注入源漏接 case 才会出现，不做静默吞）。
 */
export function assembleMessages(
    modules: PromptModule[],
    sources: AssemblySources | PersonaAssemblySources,
): AssemblyResult {
    const sorted = [...modules].sort((a, b) => a.order - b.order);
    const family = familyOf(sources);
    const messages: AssemblyMessage[] = [];
    const trace: ModuleTrace[] = [];

    for (const mod of sorted) {
        if (!mod.enabled) {
            trace.push({ moduleId: mod.id, moduleName: mod.name, kind: mod.kind, source: mod.kind === 'inject' ? mod.source : undefined, injected: false, note: '模块已停用' });
            continue;
        }
        const plan = mod.kind === 'text' ? planText(mod, family) : family.planInject(mod);
        for (const message of plan.messages) {
            pushMessage(messages, message);
        }
        trace.push({
            moduleId: mod.id,
            moduleName: mod.name,
            kind: mod.kind,
            source: mod.kind === 'inject' ? mod.source : undefined,
            injected: plan.injected,
            note: plan.note,
        });
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
