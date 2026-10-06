/**
 * 统一端点表存储域（extension_settings.ttToolkit.apis）。
 *
 * choice 与 persona 共用一套 API 端点。域形状＝端点数组
 * Array<ApiEndpoint>。读写纪律照 persona/choice 存储域：getGlobal/
 * setGlobal 单通道、normalize 未知字段丢弃、缺字段补默认、反复读写幂等。
 */

import { getGlobal, setGlobal } from '@/storage/service';
import { newId } from '@/storage';
import type { ApiEndpoint } from './types';

/** 统一端点表域键（extension_settings.ttToolkit 下）。 */
export const APIS_DOMAIN_KEY = 'apis';

/** 全局活动端点键（extension_settings.ttToolkit 顶层；类型在 GlobalDomain）。 */
export const ACTIVE_ENDPOINT_KEY = 'activeEndpointId';

/** 破限预设名键（extension_settings.ttToolkit 顶层；''＝不启用）。 */
export const JAILBREAK_PRESET_KEY = 'jailbreakPreset';

/**
 * 读全局活动端点 id（''＝未选态：键缺席/非字符串皆归 ''）。
 * choice 与 persona 的端点解析共用此单通道，不再各持任务域选中键。
 */
export function readActiveEndpointId(): string {
    const raw = getGlobal<unknown>(ACTIVE_ENDPOINT_KEY);
    return typeof raw === 'string' ? raw : '';
}

/** 写全局活动端点 id（API 页「使用」按钮通道；''＝清回未选态）。 */
export function setActiveEndpointId(id: string): void {
    setGlobal(ACTIVE_ENDPOINT_KEY, id);
}

/** 读选中破限预设名（''＝不启用：键缺席/非字符串皆归 ''）。 */
export function readJailbreakPreset(): string {
    const raw = getGlobal<unknown>(JAILBREAK_PRESET_KEY);
    return typeof raw === 'string' ? raw : '';
}

/** 写选中破限预设名（API 页「生成注入」卡通道；''＝关）。 */
export function writeJailbreakPreset(name: string): void {
    setGlobal(JAILBREAK_PRESET_KEY, name);
}

function normalizeString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

/** 单条端点归一：未知字段丢弃；无 id＝坏档剔除。 */
function normalizeEndpoint(value: unknown): ApiEndpoint | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id) return null;
    return {
        id,
        name: normalizeString(raw.name, '未命名端点'),
        url: normalizeString(raw.url, ''),
        key: normalizeString(raw.key, ''),
        model: normalizeString(raw.model, ''),
    };
}

/** 端点表归一（坏条目剔除；非数组输入归空表）。 */
export function normalizeApiDomain(value: unknown): ApiEndpoint[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        const endpoint = normalizeEndpoint(item);
        return endpoint ? [endpoint] : [];
    });
}

/** 读统一端点表（读侧归一：坏档条目不进内存）。 */
export function readApiDomain(): ApiEndpoint[] {
    return normalizeApiDomain(getGlobal(APIS_DOMAIN_KEY));
}

/** 写端点表单通道（写侧再归一：坏值不会经写通道持久化）。 */
export function writeApiDomain(next: ApiEndpoint[]): void {
    setGlobal(APIS_DOMAIN_KEY, normalizeApiDomain(next));
}

/** 按 id 查端点（命中返回条目；缺席返回 null）。 */
export function resolveEndpointById(id: string): ApiEndpoint | null {
    return readApiDomain().find(e => e.id === id) ?? null;
}

/** 新建端点骨架（id 冲突域内唯一；字段由调用方填）。 */
export function createEndpoint(name: string): ApiEndpoint {
    return {
        id: newId('endpoint'),
        name,
        url: '',
        key: '',
        model: '',
    };
}

/** 读-改-写单通道（照 choice/persona 域纪律）。 */
export function mutateApiDomain(mutate: (endpoints: ApiEndpoint[]) => void): void {
    const endpoints = readApiDomain();
    mutate(endpoints);
    writeApiDomain(endpoints);
}

/** 增改单条端点（按 id 整体替换；新增即追加）。 */
export function upsertEndpoint(endpoint: ApiEndpoint): void {
    mutateApiDomain(list => {
        const idx = list.findIndex(e => e.id === endpoint.id);
        if (idx >= 0) list[idx] = endpoint;
        else list.push(endpoint);
    });
}

/**
 * 删除端点。删除的是当前活动端点时全局选中键同步清空——悬空引用没有
 * 「上次选择」可回退，直接回「未选择」态（两任务的生成入口各自 fail fast）。
 */
export function deleteEndpoint(id: string): void {
    mutateApiDomain(list => {
        const idx = list.findIndex(e => e.id === id);
        if (idx >= 0) list.splice(idx, 1);
    });
    if (readActiveEndpointId() === id) setActiveEndpointId('');
}
