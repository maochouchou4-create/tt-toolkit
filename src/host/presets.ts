/**
 * TT 宿主 openai 预设读取通道（预设清单＋破限注入条目读取）。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - st-context.js:293 `getPresetManager`（转发 preset-manager.js:97
 *   getPresetManager(apiId)）；st-context.js:233 `chatCompletionSettings:
 *   oai_settings`（当前激活预设名＝oai_settings.preset_settings_openai）。
 * - preset-manager.js:549 `getPresetList(api)` 返回
 *   {presets, preset_names, settings}；openai 桶的 preset_names 是
 *   {名字:索引} 对象（部分 API 是名字数组——双形态兼容平移，口径见
 *   getCompletionPresetByName :777 的 Array.isArray 分支）。
 * - preset-manager.js:777 `getCompletionPresetByName(name)`：按名取预设，
 *   未找到返回 undefined（宿主自身 console.error，本层不重复报）。
 * - 宿主把启用态存 prompt_order（character_id=100001 的段，元素
 *   {identifier,enabled}），prompt 对象本身无 enabled 字段、标识字段是
 *   identifier 非 id——字段口径错任何一条都恒空。
 */

import { getTavernContext } from './context';
import type { TauriTavernPresetManager } from '@sillytavern/scripts/st-context';
import { createTtlog } from './ttlog';

const log = createTtlog('host/presets');

/** 预设对象消费子集（宽松宿主形态的收窄读）。 */
interface PresetLike {
    prompts?: Array<{ identifier?: string; role?: string; content?: string; enabled?: boolean; marker?: boolean }>;
    prompt_order?: Array<{ character_id?: number; order?: Array<{ identifier?: string; enabled?: boolean }> }>;
}

/** getPresetManager('openai') 通道（宿主上下文缺席返回 null）。 */
function openaiPresetManager(): TauriTavernPresetManager | null {
    const getter = getTavernContext()?.getPresetManager;
    if (typeof getter !== 'function') return null;
    return getter('openai') ?? null;
}

/** 预设名清单（TT 的 {名字:索引} 对象形态，兼容名字数组形态；失败空表）。 */
export function listOpenAIPresetNames(): string[] {
    try {
        const list = openaiPresetManager()?.getPresetList('openai') as { preset_names?: unknown } | null;
        const names = list?.preset_names;
        if (Array.isArray(names)) return names.filter((x): x is string => typeof x === 'string').sort();
        if (names && typeof names === 'object') return Object.keys(names as Record<string, unknown>).sort();
        return [];
    } catch (err) {
        log.warn('预设清单读取失败', err);
        return [];
    }
}

function presetAsRecord(value: unknown): PresetLike | null {
    return value && typeof value === 'object' ? (value as PresetLike) : null;
}

/** 启用态 Map（prompt_order character_id=100001 段 → identifier→enabled）。 */
function enabledOrderMap(preset: PresetLike): Map<string, boolean> {
    const orderList = (Array.isArray(preset.prompt_order) ? preset.prompt_order : [])
        .find(po => po.character_id === 100001)?.order ?? [];
    return new Map(orderList.map(o => [o.identifier ?? '', !!o.enabled]));
}

/** 注入条目（破限预设的文本件：原角色原顺序）。 */
export interface PresetInjectMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/**
 * 破限注入读取：按名取预设「启用的文本条目」——prompt_order 启用态过滤、
 * marker 占位剔除、空内容剔除，原角色原顺序返回（assistant 开场条目靠保住
 * 角色形态才成立，不做改写）。预设缺席/无可用条目/通道缺席返回 null，
 * 调用方 fail-soft 不注入。角色收窄：宿主杂散角色值归 system。
 */
export function readPresetInjectMessages(name: string): PresetInjectMessage[] | null {
    if (!name) return null;
    try {
        const manager = openaiPresetManager();
        if (!manager) return null;
        const preset = presetAsRecord(manager.getCompletionPresetByName(name));
        if (!preset?.prompts) return null;
        // 启用序不可判（prompt_order 缺席/无 100001 段）＝异构或坏数据预设：
        // 回落 p.enabled??true 会把全部文本条目（含 main/cns 等杂件）整包
        // 注入——判不出干净启用态就不产数据，走 fail-soft 不注入
        const enabledById = enabledOrderMap(preset);
        if (enabledById.size === 0) return null;
        const messages: PresetInjectMessage[] = preset.prompts
            .filter(p => (enabledById.get(p.identifier ?? '') ?? p.enabled ?? true)
                && !p.marker
                && typeof p.content === 'string' && p.content.trim() !== '')
            .map(p => ({
                role: p.role === 'user' || p.role === 'assistant' ? p.role : 'system',
                content: p.content ?? '',
            }));
        return messages.length > 0 ? messages : null;
    } catch (err) {
        log.warn('破限预设读取失败', err);
        return null;
    }
}

/**
 * 生成用 system prompt 解析与预设下拉（任务级预设选择）已随全局破限
 * 预设统一而退役——预设对生成的影响只走传输层注入（readPresetInject
 * Messages，见 apis/preset-inject）；本文件保留清单读取与注入条目读取。
 */
