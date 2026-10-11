/**
 * 任务档案存储域（extension_settings.ttToolkit.taskProfiles）。
 *
 * 任务出站路由单通道：档案（该任务走哪个服务商＋哪个模型＋温度/
 * 思考强度）→ 服务商表 → { url, key, model, temperature, reasoningEffort }。
 * 全仓唯一出站身份解析点（resolveTaskRoute），消费方禁旁路直读档案。
 *
 * 读写纪律照 apis 域：getGlobal/setGlobal 单通道、normalize 缺行补默认、
 * 坏值钳制、反复读写幂等。
 */

import { getGlobal, setGlobal } from '@/storage/service';
import { TASK_IDS, type TaskId } from '@/tasks';
import type { ReasoningEffort } from './client';
import { readApiDomain } from './storage';
import { TASK_PARAMS } from './task-defaults';

/** 任务档案域键（extension_settings.ttToolkit 下；字面量仅此一份）。 */
export const TASK_PROFILES_KEY = 'taskProfiles';

/**
 * 任务档案值：该任务出站走哪个服务商＋哪个模型＋温度/思考强度
 * （providerId/model 空＝未配置，入口 fail fast；temperature/reasoningEffort
 * 缺席＝任务默认档——改默认值时未动过的行自动跟随）。
 */
export interface TaskProfile {
    providerId: string;
    model: string;
    /** 采样温度（任务级配置）：缺席＝TASK_PARAMS 默认值；normalize 钳制 0-2、非数剔除。 */
    temperature?: number;
    /** 思考强度（任务级配置）：缺席＝TASK_PARAMS 默认档；normalize 枚举外剔除。 */
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high';
}

/** 域形状：五行齐全（normalize 补缺行）。 */
export type TaskProfilesDomain = Record<TaskId, TaskProfile>;

/** 未配置行的统一形状（迁移初始化与删除联动共用同一「回未配置态」语义）。 */
export function emptyTaskProfile(): TaskProfile {
    return { providerId: '', model: '' };
}

function normalizeString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** 单行归一：providerId/model 坏类型归空串；温度钳 0-2、非数剔除；思考强度枚举外剔除。 */
function normalizeProfile(value: unknown): TaskProfile {
    if (!value || typeof value !== 'object') return emptyTaskProfile();
    const raw = value as Record<string, unknown>;
    const profile: TaskProfile = {
        providerId: normalizeString(raw.providerId),
        model: normalizeString(raw.model),
    };
    if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)) {
        profile.temperature = Math.min(2, Math.max(0, raw.temperature));
    }
    if (typeof raw.reasoningEffort === 'string'
        && (['off', 'low', 'medium', 'high'] as const).includes(raw.reasoningEffort as ReasoningEffort)) {
        profile.reasoningEffort = raw.reasoningEffort as ReasoningEffort;
    }
    return profile;
}

/** 任务档案归一（纯函数：五行齐全，坏值钳制，未知键丢弃）。 */
export function normalizeTaskProfiles(value: unknown): TaskProfilesDomain {
    const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const domain = {} as TaskProfilesDomain;
    for (const id of TASK_IDS) {
        domain[id] = normalizeProfile(raw[id]);
    }
    return domain;
}

/** 读任务档案（读侧归一：缺行补未配置态）。 */
export function readTaskProfiles(): TaskProfilesDomain {
    return normalizeTaskProfiles(getGlobal<unknown>(TASK_PROFILES_KEY));
}

/** 写任务档案单通道（写侧再归一：坏值不经写通道持久化）。 */
export function writeTaskProfiles(next: TaskProfilesDomain): void {
    setGlobal(TASK_PROFILES_KEY, normalizeTaskProfiles(next));
}

/** 读-改-写单通道。 */
export function mutateTaskProfiles(mutate: (profiles: TaskProfilesDomain) => void): void {
    const profiles = readTaskProfiles();
    mutate(profiles);
    writeTaskProfiles(profiles);
}

/** 任务出站路由（消费方调用面形态；GenerationApiConfig 等按它引用）。 */
export interface TaskRoute {
    url: string;
    key: string;
    model: string;
    temperature: number;
    reasoningEffort: ReasoningEffort;
}

/** 任务出站路由（档案 → 服务商表）。未配置/悬空/缺模型返回 null＝入口 fail fast。 */
export function resolveTaskRoute(task: TaskId): TaskRoute | null {
    const profile = readTaskProfiles()[task];
    if (!profile.providerId || !profile.model) return null;
    const provider = readApiDomain().find(p => p.id === profile.providerId);
    if (!provider) return null;
    return {
        url: provider.url,
        key: provider.key,
        model: profile.model,
        temperature: profile.temperature ?? TASK_PARAMS[task].defaultTemperature,
        reasoningEffort: profile.reasoningEffort ?? TASK_PARAMS[task].defaultReasoningEffort,
    };
}

/**
 * 删除服务商时的档案联动：引用它的任务行重置回未配置态——悬空引用
 * 没有可回退值，回未配置态由各任务入口 fail fast 接住。
 */
export function resetTaskProfilesForProvider(providerId: string): void {
    mutateTaskProfiles(profiles => {
        for (const id of TASK_IDS) {
            if (profiles[id].providerId === providerId) profiles[id] = emptyTaskProfile();
        }
    });
}

/**
 * 批量设置行的存储写口：一次性把五行档案指到同一服务商与模型。
 * 值照写（含空串），非空 gate 由调用侧把关；调参档（温度/思考）不在
 * 写面上——缺席即默认档是档案语义的一部分，批量换路由不应改动它。
 */
export function setRouteForAllTasks(providerId: string, model: string): void {
    mutateTaskProfiles(profiles => {
        for (const id of TASK_IDS) {
            profiles[id] = { ...profiles[id], providerId, model };
        }
    });
}
