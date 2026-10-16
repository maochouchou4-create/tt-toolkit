/**
 * 统一服务商表存储域（extension_settings.ttToolkit.apis）。
 *
 * url+key＝服务商接入身份，全任务共用一张表；模型选择权在任务档案
 * （task-profiles）。域形状＝服务商数组 Array<ApiProvider>。读写纪律照
 * persona/choice 存储域：getGlobal/setGlobal 单通道、normalize 未知字段
 * 丢弃（旧档 model 字段自然丢弃）、缺字段补默认、反复读写幂等。
 */

import { getGlobal, setGlobal } from '@/storage/service';
import { newId } from '@/storage';
import type { ApiProvider } from './types';
import { resetTaskProfilesForProvider } from './task-profiles';

/** 统一服务商表域键（extension_settings.ttToolkit 下）。 */
export const APIS_DOMAIN_KEY = 'apis';

/** 破限预设名键（extension_settings.ttToolkit 顶层；''＝不启用）。 */
export const JAILBREAK_PRESET_KEY = 'jailbreakPreset';

/** 全局域键登记：键常量与域类型同处归属模块（登记面说明见 storage/service.ts）。 */
declare module '@/storage/service' {
    interface GlobalDomain {
        /** 统一服务商表（本文件 APIS_DOMAIN_KEY） */
        apis?: ApiProvider[];
        /** 破限预设名（本文件 JAILBREAK_PRESET_KEY） */
        jailbreakPreset?: string;
    }
}

/** 读选中破限预设名（''＝不启用：键缺席/非字符串皆归 ''）。 */
export function readJailbreakPreset(): string {
    const raw = getGlobal(JAILBREAK_PRESET_KEY);
    return typeof raw === 'string' ? raw : '';
}

/** 写选中破限预设名（API 页「生成注入」卡通道；''＝关）。 */
export function writeJailbreakPreset(name: string): void {
    setGlobal(JAILBREAK_PRESET_KEY, name);
}

function normalizeString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

/** 单条服务商归一：未知字段丢弃（旧档 model 字段自然退役）；无 id＝坏档剔除。 */
function normalizeProvider(value: unknown): ApiProvider | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id) return null;
    return {
        id,
        name: normalizeString(raw.name, '未命名服务商'),
        url: normalizeString(raw.url, ''),
        key: normalizeString(raw.key, ''),
        models: Array.isArray(raw.models) ? raw.models.filter((m): m is string => typeof m === 'string') : [],
        noPrefill: raw.noPrefill === true,
    };
}

/** 服务商表归一（坏条目剔除；非数组输入归空表）。 */
export function normalizeApiDomain(value: unknown): ApiProvider[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        const provider = normalizeProvider(item);
        return provider ? [provider] : [];
    });
}

/** 读统一服务商表（读侧归一：坏档条目不进内存）。 */
export function readApiDomain(): ApiProvider[] {
    return normalizeApiDomain(getGlobal(APIS_DOMAIN_KEY));
}

/** 写服务商表单通道（写侧再归一：坏值不会经写通道持久化）。 */
export function writeApiDomain(next: ApiProvider[]): void {
    setGlobal(APIS_DOMAIN_KEY, normalizeApiDomain(next));
}

/** 新建服务商骨架（id 冲突域内唯一；字段由调用方填）。 */
export function createEndpoint(name: string): ApiProvider {
    return {
        id: newId('endpoint'),
        name,
        url: '',
        key: '',
        models: [],
        noPrefill: false,
    };
}

/** 读-改-写单通道（照 choice/persona 域纪律）。 */
export function mutateApiDomain(mutate: (providers: ApiProvider[]) => void): void {
    const providers = readApiDomain();
    mutate(providers);
    writeApiDomain(providers);
}

/** 增改单条服务商（按 id 整体替换；新增即追加）。 */
export function upsertEndpoint(endpoint: ApiProvider): void {
    mutateApiDomain(list => {
        const idx = list.findIndex(p => p.id === endpoint.id);
        if (idx >= 0) list[idx] = endpoint;
        else list.push(endpoint);
    });
}

/**
 * 置单条服务商的 noPrefill 能力记忆，返回是否真的改动（条目在且值不同）。
 * 两种 false 同义：providerId 悬空（生成进行中服务商被删是合法并发态，
 * 标记无落点即丢）与已处目标值（重复学习/重复复位）——都不该惊动消费面，
 * 调用方按返回值决定要不要 bump revision（域重写照本文件既有写口纪律）。
 */
export function setProviderNoPrefill(providerId: string, value: boolean): boolean {
    let changed = false;
    mutateApiDomain(list => {
        const idx = list.findIndex(p => p.id === providerId);
        if (idx < 0 || list[idx].noPrefill === value) return;
        list[idx] = { ...list[idx], noPrefill: value };
        changed = true;
    });
    return changed;
}

/**
 * 删除服务商。被任务档案引用时引用行同步重置回未配置态——悬空引用
 * 没有「上次选择」可回退（各任务生成入口 fail fast 指路任务模型卡）。
 */
export function deleteEndpoint(id: string): void {
    mutateApiDomain(list => {
        const idx = list.findIndex(p => p.id === id);
        if (idx >= 0) list.splice(idx, 1);
    });
    resetTaskProfilesForProvider(id);
}
