/**
 * TT 宿主 openai 预设读取通道（批D persona 的预设选择/提示词对照供给）。
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
import { createTtlog } from './ttlog';

const log = createTtlog('host/presets');

/** 预设对象消费子集（宽松宿主形态的收窄读）。 */
interface PresetLike {
    prompts?: Array<{ identifier?: string; role?: string; content?: string; enabled?: boolean }>;
    prompt_order?: Array<{ character_id?: number; order?: Array<{ identifier?: string; enabled?: boolean }> }>;
}

/** getPresetManager('openai') 通道（宿主上下文缺席返回 null）。 */
function openaiPresetManager(): { getCompletionPresetByName?: (name: string) => unknown } | null {
    const getter = getTavernContext()?.getPresetManager;
    if (typeof getter !== 'function') return null;
    const manager = (getter as (apiId: string) => unknown)('openai');
    return manager && typeof manager === 'object' ? (manager as { getCompletionPresetByName?: (name: string) => unknown }) : null;
}

/** 预设名清单（TT 的 {名字:索引} 对象形态，兼容名字数组形态；失败空表）。 */
export function listOpenAIPresetNames(): string[] {
    try {
        const manager = openaiPresetManager();
        const getPresetList = (manager as { getPresetList?: (api: string) => unknown } | null)?.getPresetList;
        if (typeof getPresetList !== 'function') return [];
        const list = getPresetList('openai') as { preset_names?: unknown } | null;
        const names = list?.preset_names;
        if (Array.isArray(names)) return names.filter((x): x is string => typeof x === 'string').sort();
        if (names && typeof names === 'object') return Object.keys(names as Record<string, unknown>).sort();
        return [];
    } catch (err) {
        log.warn('预设清单读取失败', err);
        return [];
    }
}

/** 系统段抽取（prompt_order character_id=100001 段的启用 Map → prompts 过滤拼接）。 */
function extractSystemParts(preset: PresetLike | null | undefined): string {
    if (!preset || !preset.prompts) return '';
    const orderList = (Array.isArray(preset.prompt_order) ? preset.prompt_order : [])
        .find(po => po.character_id === 100001)?.order ?? [];
    const enabledById = new Map(orderList.map(o => [o.identifier ?? '', !!o.enabled]));
    return preset.prompts
        .filter(p => (enabledById.get(p.identifier ?? '') ?? p.enabled ?? true) && (
            p.role === 'system' ||
            ['main', 'jailbreak', 'nsfw', 'jailbreak_prompt', 'main_prompt'].includes(p.identifier ?? '')
        ))
        .map(p => p.content ?? '')
        .join('\n\n');
}

function presetAsRecord(value: unknown): PresetLike | null {
    return value && typeof value === 'object' ? (value as PresetLike) : null;
}

/**
 * 生成用 system prompt 解析（旧 getRealSystemPrompt 平移）：
 * 'pure' → 空串（No Main / No JB）；具名 → 该预设的 system 段（预设存在
 * 即以其为准，无 system 部件也返回空串，不落到当前模式）；'current'/其它 →
 * 酒馆当前激活 openai 预设。取不到即空串（requestOnce 对空串不入 messages）。
 */
export function resolvePresetSystemPrompt(selectedPreset: string): string {
    if (selectedPreset === 'pure') {
        return '';
    }

    const manager = openaiPresetManager();
    const byName = manager?.getCompletionPresetByName;

    if (selectedPreset && selectedPreset !== 'current') {
        if (typeof byName === 'function') {
            try {
                const preset = presetAsRecord(byName(selectedPreset));
                if (preset) return extractSystemParts(preset);
            } catch (err) {
                log.warn('指定预设装载失败', { selectedPreset, err });
            }
        }
    }

    try {
        const chatSettings = getTavernContext()?.chatCompletionSettings as Record<string, unknown> | undefined;
        const currentName = chatSettings?.preset_settings_openai;
        if (typeof byName === 'function' && typeof currentName === 'string') {
            const preset = presetAsRecord(byName(currentName));
            const systemParts = preset ? extractSystemParts(preset) : '';
            if (systemParts.trim().length > 0) {
                return systemParts;
            }
        }
    } catch (err) {
        log.warn('当前预设 system 段抽取失败', err);
    }

    return '';
}

/** 预设下拉选项（current/pure 两默认项 + 宿主预设清单，module 层直接消费）。 */
export function buildPresetOptions(): string[] {
    return ['current', 'pure', ...listOpenAIPresetNames()];
}
