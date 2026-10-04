/**
 * 组装引擎（纯函数核心，方案 §2.3 统一单条模块管线）。
 *
 * 纯函数设计：宿主数据由 sources 层收集成 AssemblySources（普通数据
 * 对象）后传入——engine 不碰宿主 API，node 冒烟与浏览器共用同一条
 * 组装路径（dump 断言的可机判前提）。占位符替换全部确定性（{{user}}/
 * {{char}}/{{count}}/{{min_chars}}/{{max_chars}}——值由 sources 提供）。
 */

import type {
    AssemblyMessage,
    ModuleTrace,
    PromptModule,
    StoryDirection,
    StoryDirectionTagDef,
} from './types';
import { STORY_DIRECTION_TAG_DEFS } from './directions';

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
    /** 剧情走向（放任自流/未设置传 null——story_direction 模块跳过） */
    storyDirection: StoryDirection | null;
    /** 用户勾选搬入的宿主通用注入槽位（顺序＝勾选列表顺序） */
    externalSlots: Array<{ key: string; value: string }>;
    /** 柏宝书摘要文本（缺席/未开传 null） */
    baibaiSummary: string | null;
    /** 占位符值 */
    count: number;
    minChars: number;
    maxChars: number;
}

export interface AssemblyResult {
    messages: AssemblyMessage[];
    trace: ModuleTrace[];
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
    module: PromptModule & { kind: 'inject' },
    sources: AssemblySources,
): { content: string; note: string } {
    switch (module.source) {
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
            if (!sources.storyDirection) return { content: '', note: '剧情走向＝放任自流或未设置（不注入）' };
            const def = directionDefOf(sources.storyDirection.tag);
            const free = sources.storyDirection.freeText.trim();
            const body = free ? `${def.guidance}\n补充指引：${free}` : def.guidance;
            return { content: wrapTag('direction', body, sources), note: '' };
        }
        case 'external_slot': {
            if (sources.externalSlots.length === 0) return { content: '', note: '未勾选任何宿主注入槽位' };
            const blocks = sources.externalSlots.map(s => s.value.trim()).filter(Boolean);
            if (blocks.length === 0) return { content: '', note: '勾选的槽位内容全为空' };
            return { content: wrapTag('external_memory', blocks.join('\n\n'), sources), note: '' };
        }
        case 'baibai':
            return sources.baibaiSummary && sources.baibaiSummary.trim()
                ? {
                      content: wrapTag(
                          'past_events',
                          `以下是记忆系统对已离开当前上下文窗口的历史剧情摘要，供保持剧情连贯参考：\n${sources.baibaiSummary.trim()}`,
                          sources,
                      ),
                      note: '',
                  }
                : { content: '', note: '柏宝书摘要不可用（插件缺席或未返回）' };
    }
}

/** 分段标签包裹（§2.3 制版原则：结构化分段标签）＋占位符填充。 */
function wrapTag(tag: string, body: string, sources: AssemblySources): string {
    return fillPlaceholders(`<${tag}>\n${body}\n</${tag}>`, sources);
}

function directionDefOf(tag: string): StoryDirectionTagDef {
    return (
        STORY_DIRECTION_TAG_DEFS.find(d => d.id === tag) ??
        (STORY_DIRECTION_TAG_DEFS[0] as StoryDirectionTagDef)
    );
}

/**
 * 组装消息数组（模块管线主入口）。
 *
 * 消息序列规则：
 *   - 模块按 order 升序逐个求值；chat_history 展开为多条 user/assistant
 *     消息（角色由楼层来源决定，不随模块 role 走——历史角色语义属于
 *     对话本身）；其余模块产出单条 role 消息。
 *   - 相邻同 role 合并（system/assistant；user 不互相合并——聊天历史末
 *     条 user 与任务指令同为 user 时，合并会把「任务指令」混进历史正文，
 *     user 消息在提示词里是独立输入边界）。
 */
export function assembleMessages(modules: PromptModule[], sources: AssemblySources): AssemblyResult {
    const sorted = [...modules].sort((a, b) => a.order - b.order);
    const messages: AssemblyMessage[] = [];
    const trace: ModuleTrace[] = [];

    for (const mod of sorted) {
        if (!mod.enabled) {
            trace.push({ moduleId: mod.id, moduleName: mod.name, kind: mod.kind, source: mod.kind === 'inject' ? mod.source : undefined, injected: false, note: '模块已停用' });
            continue;
        }
        if (mod.kind === 'text') {
            const content = fillPlaceholders(mod.content, sources).trim();
            if (!content) {
                trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'text', injected: false, note: '文本为空' });
                continue;
            }
            pushMessage(messages, { role: mod.role, content });
            trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'text', injected: true, note: '' });
            continue;
        }
        // inject 模块
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
        const { content, note } = resolveInjectContent(mod, sources);
        if (!content.trim()) {
            trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'inject', source: mod.source, injected: false, note: note || '注入内容为空' });
            continue;
        }
        pushMessage(messages, { role: mod.role, content: content.trim() });
        trace.push({ moduleId: mod.id, moduleName: mod.name, kind: 'inject', source: mod.source, injected: true, note: '' });
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
