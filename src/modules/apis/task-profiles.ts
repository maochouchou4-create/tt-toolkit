/**
 * 任务档案存储域（extension_settings.ttToolkit.taskProfiles）。
 *
 * 任务出站路由单通道：档案（该任务走哪个服务商＋哪个模型＋温度/
 * 思考强度）→ 服务商表 → { url, key, model, temperature, reasoningEffort }。
 * 全仓唯一出站身份解析点（resolveTaskRoute），消费方禁旁路直读档案；
 * 路由 → 生成请求配置的组装同样只有一条出口（routeToRequestConfig）。
 *
 * 读写纪律照 apis 域：getGlobal/setGlobal 单通道、normalize 缺行补默认、
 * 坏值钳制、反复读写幂等。
 */

import { getGlobal, setGlobal } from '@/storage/service';
import { taskLabel, TASK_IDS, type TaskId } from '@/tasks';
import type { GenerateRequestConfig, ReasoningEffort } from './client';
import { readApiDomain } from './storage';
import { TASK_PARAMS } from './task-defaults';

/** 任务档案域键（extension_settings.ttToolkit 下；字面量仅此一份）。 */
export const TASK_PROFILES_KEY = 'taskProfiles';

/**
 * 思考强度档位清单（枚举单一真相源，守门者持有）。
 *
 * 放在这一层而不是传输层 client：档案读侧的 normalizeProfile 才是真正的守卫
 * （存档里的历史值不可信，枚举外剔除），枚举住在守卫旁边，档位增删时守卫不会
 * 与 UI 各拿一份清单漂移。客户端只消费 ReasoningEffort 类型，不重复持表。
 */
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high'] as const;

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
    reasoningEffort?: ReasoningEffort;
}

/** 域形状：全任务行齐全（normalize 补缺行）。 */
export type TaskProfilesDomain = Record<TaskId, TaskProfile>;

/** 全局域键登记：键常量与域类型同处归属模块（登记面说明见 storage/service.ts）。 */
declare module '@/storage/service' {
    interface GlobalDomain {
        /** 任务档案（本文件 TASK_PROFILES_KEY） */
        taskProfiles?: TaskProfilesDomain;
    }
}

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
        && REASONING_EFFORTS.includes(raw.reasoningEffort as ReasoningEffort)) {
        profile.reasoningEffort = raw.reasoningEffort as ReasoningEffort;
    }
    return profile;
}

/** 任务档案归一（纯函数：全任务行齐全，坏值钳制，未知键丢弃）。 */
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
    return normalizeTaskProfiles(getGlobal(TASK_PROFILES_KEY));
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
    providerId: string;
    url: string;
    key: string;
    model: string;
    temperature: number;
    reasoningEffort: ReasoningEffort;
    noPrefill: boolean;
}

/** 任务出站路由（档案 → 服务商表）。未配置/悬空/缺模型返回 null＝入口 fail fast。 */
export function resolveTaskRoute(task: TaskId): TaskRoute | null {
    const profile = readTaskProfiles()[task];
    if (!profile.providerId || !profile.model) return null;
    const provider = readApiDomain().find(p => p.id === profile.providerId);
    if (!provider) return null;
    return {
        providerId: provider.id,
        url: provider.url,
        key: provider.key,
        model: profile.model,
        temperature: profile.temperature ?? TASK_PARAMS[task].defaultTemperature,
        reasoningEffort: profile.reasoningEffort ?? TASK_PARAMS[task].defaultReasoningEffort,
        noPrefill: provider.noPrefill,
    };
}

/**
 * 「任务模型未配置」文案与错误的单点出口。
 *
 * 同一件事有三条消费路径（生成入口抛错、自动生成守卫的 console.warn、
 * 设置面 toast），此前各写一份、各自措辞还不同（人设那条甚至不带任务名）。
 * 分散的根因就是分散：加第四个任务时三处都要记得抄，漏一处就漏一句指路。
 * 任务中文名从 tasks.ts 的 label 注入，裸 taskId 不进用户可见文本。
 */
export function missingTaskModelMessage(task: TaskId): string {
    return `未配置${taskLabel(task)}模型——到「API」页「任务模型」卡给「${taskLabel(task)}」选择服务商与模型`;
}

/** 未配置态的抛错形态（生成入口 fail fast 用；文案与上一函数同源）。 */
export function missingTaskModelError(task: TaskId): Error {
    return new Error(missingTaskModelMessage(task));
}

/**
 * 任务路由 → 生成请求配置（两任务唯一的请求配置构造点）。
 *
 * 出站身份（baseUrl/apiKey/model）与采样参数（temperature/reasoningEffort）
 * 逐字段取自路由，流式/输出契约/超时按任务固化于 TASK_PARAMS。两处调用点
 * （choice 生成器、persona 生成链）此前各写一份同构字面量：加一个字段要改
 * 两处，少一处就是「某任务悄悄少发一个参数」——而少发的表现是端点行为漂移，
 * 不报错。
 *
 * **不发 max_tokens**（全任务同）：客户端 buildGenerateBody 不含该字段即
 * 不进请求体，依赖宿主 insert_if_present 语义（请求体不带的字段不会被宿主
 * 强加默认值）。服务端默认输出上限是这两任务唯一安全的取值——persona 的
 * 长 YAML 与推理模型的思维链都共享该上限，显式小上限会把正文掐断（实测
 * deepseek-flash 2048 预算被思维链耗尽、正文截断在半条 JSON）。
 */
export function routeToRequestConfig(task: TaskId, route: TaskRoute): GenerateRequestConfig {
    return {
        task,
        baseUrl: route.url,
        apiKey: route.key,
        model: route.model,
        temperature: route.temperature,
        stream: TASK_PARAMS[task].stream,
        outputContract: TASK_PARAMS[task].outputContract,
        reasoningEffort: route.reasoningEffort,
        timeoutSec: TASK_PARAMS[task].timeoutSec,
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
 * 批量设置行的存储写口：一次性把全部任务档案指到同一服务商与模型。
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
