/**
 * 任务档案存储域（extension_settings.ttToolkit.taskProfiles）＋跟随开关
 * （followTavern）。
 *
 * 任务出站路由单通道：档案（该任务走哪个服务商＋哪个模型＋温度/
 * 思考强度）→ 服务商表 → 身份与采样参数。跟随开关开时身份来源切到
 * 宿主当前连接（跟随＝出站身份与模型的来源切换，不是清空手动配置——
 * 关掉即回到档案行原值）。全仓唯一出站身份解析点（resolveTaskRoute），
 * 消费方禁旁路直读档案；路由 → 生成请求配置的组装同样只有一条出口
 * （routeToRequestConfig）。
 *
 * 读写纪律照 apis 域：getGlobal/setGlobal 单通道、normalize 缺行补默认、
 * 坏值钳制、反复读写幂等。
 */

import { getGlobal, setGlobal } from '@/storage/service';
import { taskLabel, TASK_IDS, type TaskId } from '@/tasks';
import type { GenerateRequestConfig } from './client';
import { readApiDomain } from './storage';
import { TASK_PARAMS } from './task-defaults';
import { readHostConnection, type HostConnection } from '@/host';

/** 任务档案域键（extension_settings.ttToolkit 下；字面量仅此一份）。 */
export const TASK_PROFILES_KEY = 'taskProfiles';

/** 跟随开关域键（extension_settings.ttToolkit 顶层；true＝出站身份镜像宿主当前连接）。 */
export const FOLLOW_TAVERN_KEY = 'followTavern';

/**
 * 思考强度档位清单（枚举单一真相源，守门者持有）。
 *
 * 放在这一层而不是传输层 client：档案读侧的 normalizeProfile 才是真正的守卫
 * （存档里的历史值不可信，枚举外剔除），枚举住在守卫旁边，档位增删时守卫不会
 * 与 UI 各拿一份清单漂移。客户端只消费 ReasoningEffort 类型，不重复持表。
 */
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high'] as const;

/**
 * 思考强度档位（由清单派生，禁另写一份字面量联合）：'off'＝不发送该字段
 * （默认——见 UI 端点配置的说明文案）；'low'|'medium'|'high' 映射为 OpenAI
 * reasoning_effort 值。派生而非手写是本条存在的理由：清单加档而类型没跟上时，
 * 这里编译期即断，而手写联合要等某个赋值点撞上才暴露。
 */
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

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
        /** 跟随酒馆会话连接开关（本文件 FOLLOW_TAVERN_KEY） */
        followTavern?: boolean;
    }
}

/** 读跟随开关（非布尔/缺席＝关）。 */
export function readFollowTavern(): boolean {
    return getGlobal(FOLLOW_TAVERN_KEY) === true;
}

/** 写跟随开关单通道（非布尔不落盘）。 */
export function writeFollowTavern(value: boolean): void {
    setGlobal(FOLLOW_TAVERN_KEY, value);
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

/** 服务商表身份（手动配置态）：直连地址与密钥，出站恒走 custom 源。 */
export interface TaskRouteProviderIdentity {
    kind: 'provider';
    url: string;
    key: string;
}

/**
 * 宿主连接身份（跟随态）：镜像酒馆当前连接的源/自定义地址/反代。
 * 密钥不在此处——宿主后端按源自取（custom 源 secret store CUSTOM 键、
 * 非 custom 源按源取官方 URL＋密钥，见 host/connection.ts 核实记录），
 * 两态身份的合法组合由判别联合保证，调用方无需记字段规则。
 */
export interface TaskRouteHostIdentity {
    kind: 'host';
    source: string;
    customUrl: string;
    reverseProxy: string;
    proxyPassword: string;
}

export type TaskRouteIdentity = TaskRouteProviderIdentity | TaskRouteHostIdentity;

/** 任务出站路由（消费方调用面形态；GenerationApiConfig 等按它引用）。 */
export interface TaskRoute {
    /** 手动配置态＝服务商 id；跟随态恒 ''。 */
    providerId: string;
    identity: TaskRouteIdentity;
    model: string;
    temperature: number;
    reasoningEffort: ReasoningEffort;
    noPrefill: boolean;
}

/**
 * 跟随不支持的宿主源（黑名单）：这些源的流式帧不是 OpenAI 方言
 * （delta 在 choices[0].delta.content）——宿主对上游帧原样重帧不归一
 * （判据＝宿主 openai.js:4843 getStreamingReply 的分源分支），本扩展的
 * 流读取器拼不出正文，硬跟只会得到假空响应。黑名单而非白名单：OpenAI
 * 方言族是主流且持续新增，黑名单小而稳，新 OpenAI 兼容源自动可跟。
 */
const NON_FOLLOWABLE_SOURCES = ['claude', 'makersuite', 'vertexai', 'cohere', 'aws_bedrock'];

/**
 * 宿主源的用户可读名（酒馆连接面板同款叫法）：挡因文案与跟随状态行的
 * 「跟随中：源 · 模型」共用；未映射的源裸值兜底。只作文案，不进判据
 * ——可跟与否只看 NON_FOLLOWABLE_SOURCES 黑名单。
 */
const SOURCE_LABELS: Record<string, string> = {
    claude: 'Claude',
    makersuite: 'Gemini',
    vertexai: 'Vertex AI',
    cohere: 'Cohere',
    aws_bedrock: 'AWS Bedrock',
    custom: '自定义',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    deepseek: 'DeepSeek',
    mistralai: 'Mistral',
    xai: 'xAI',
    zai: 'Z.AI',
    moonshot: 'Moonshot',
    opencode: 'OpenCode',
};

/** 源的报文格式（custom/opencode 专用；''＝缺省，宿主口径缺省即 openai_compat）。 */
function connectionApiFormat(conn: HostConnection): string {
    if (conn.source === 'custom') return conn.customApiFormat;
    if (conn.source === 'opencode') return conn.opencodeApiFormat;
    return '';
}

/**
 * 跟随被挡的原因（纯判据：拿连接快照逐层给因；可跟＝null。宿主上下文
 * 缺席的判挡归调用方——各调用点对 null 有不同消费面）。
 * 跟随关/主接口非聊天补全/挡源/报文格式非 OpenAI 兼容/custom 缺地址/
 * 未选模型各给一句人话——「跟不了」必须说得出来为什么，否则用户看到的
 * 是莫名其妙的未配置报错。
 */
function followBlockReasonFor(conn: HostConnection): string | null {
    if (conn.mainApi !== 'openai') return '跟随不可用：酒馆主接口不是聊天补全（Chat Completion）';
    if (NON_FOLLOWABLE_SOURCES.includes(conn.source)) {
        const label = SOURCE_LABELS[conn.source] ?? conn.source;
        return `跟随不可用：当前酒馆连接是「${label}」官方源，跟随只支持 OpenAI 兼容的连接`;
    }
    const apiFormat = connectionApiFormat(conn);
    if (apiFormat !== '' && apiFormat !== 'openai_compat') {
        return `跟随不可用：酒馆自定义连接的报文格式是「${apiFormat}」，跟随只支持 OpenAI 兼容格式`;
    }
    if (conn.source === 'custom' && conn.customUrl === '') return '跟随不可用：酒馆自定义端点未填地址';
    if (conn.model === '') return '跟随不可用：酒馆当前连接未选择模型';
    return null;
}

/**
 * 跟随被挡的对外读取口（跟随关＝null；API 页状态行与入口 fail fast 共用）。
 */
export function followBlockReason(): string | null {
    if (!readFollowTavern()) return null;
    const conn = readHostConnection();
    return conn === null ? '跟随不可用：读不到酒馆的连接状态' : followBlockReasonFor(conn);
}

/**
 * 跟随状态快照（API 页「任务模型」卡状态行数据；判挡与文案同处单点，
 * store 只存不造文案）。三态常驻：关（muted）/开且可跟（ok）/开且被挡（err）。
 */
export interface FollowStatus {
    /** 开关开合（状态行 tone 的分支：开→ok/err，关→muted）。 */
    on: boolean;
    /** 开且可跟＝true；开且被挡＝false；关＝true（无状态可错）。 */
    ok: boolean;
    text: string;
}

/** 组装跟随状态快照（单次读宿主连接，判挡与展示一致；文案三态常驻）。 */
export function readFollowStatus(): FollowStatus {
    if (!readFollowTavern()) return { on: false, ok: true, text: '未跟随——两任务按下方任务模型卡出站' };
    const conn = readHostConnection();
    if (conn === null) return { on: true, ok: false, text: '跟随不可用：读不到酒馆的连接状态' };
    const issue = followBlockReasonFor(conn);
    if (issue !== null) return { on: true, ok: false, text: issue };
    return { on: true, ok: true, text: `跟随中：${SOURCE_LABELS[conn.source] ?? conn.source} · ${conn.model}` };
}

/** 跟随态的宿主身份组装（判挡在前，调用点保证 conn 可跟）。 */
function hostIdentityFrom(conn: HostConnection): TaskRouteHostIdentity {
    return {
        kind: 'host',
        source: conn.source,
        customUrl: conn.customUrl,
        reverseProxy: conn.reverseProxy,
        proxyPassword: conn.proxyPassword,
    };
}

/**
 * 任务出站路由（全仓唯一解析点）。跟随开＝宿主当前连接（实时读，档案行
 * 的调参档仍生效——跟随替换的是身份与模型，不是采样参数）；跟随关＝
 * 档案行 → 服务商表。未配置/悬空/缺模型/跟随被挡返回 null＝入口 fail fast。
 */
export function resolveTaskRoute(task: TaskId): TaskRoute | null {
    const profile = readTaskProfiles()[task];
    const temperature = profile.temperature ?? TASK_PARAMS[task].defaultTemperature;
    const reasoningEffort = profile.reasoningEffort ?? TASK_PARAMS[task].defaultReasoningEffort;
    if (readFollowTavern()) {
        const conn = readHostConnection();
        if (conn === null || followBlockReasonFor(conn) !== null) return null;
        // noPrefill 恒 false：能力记忆绑在服务商行上，跟随态没有行——
        // 400 去-prefill 重试照常当场重试，跨会话记忆无落点即丢
        return { providerId: '', identity: hostIdentityFrom(conn), model: conn.model, temperature, reasoningEffort, noPrefill: false };
    }
    if (!profile.providerId || !profile.model) return null;
    const provider = readApiDomain().find(p => p.id === profile.providerId);
    if (!provider) return null;
    return {
        providerId: provider.id,
        identity: { kind: 'provider', url: provider.url, key: provider.key },
        model: profile.model,
        temperature,
        reasoningEffort,
        noPrefill: provider.noPrefill,
    };
}

/**
 * 「任务路由不可用」文案与错误的单点出口。
 *
 * 两条路：跟随开且被挡 → 挡因（followBlockReason）；否则 → 未配置指路
 * 任务模型卡的原句。此前各消费点自写措辞（人设那条甚至不带任务名），
 * 分散的根因就是分散——文案单点，加第四个任务不用记得抄。
 * 任务中文名从 tasks.ts 的 label 注入，裸 taskId 不进用户可见文本。
 */
export function routeUnavailableMessage(task: TaskId): string {
    const followIssue = followBlockReason();
    if (followIssue) return followIssue;
    return `未配置${taskLabel(task)}模型——到「API」页「任务模型」卡给「${taskLabel(task)}」选择服务商与模型`;
}

/** 路由不可用态的抛错形态（生成入口 fail fast 用；文案与上一函数同源）。 */
export function routeUnavailableError(task: TaskId): Error {
    return new Error(routeUnavailableMessage(task));
}

/**
 * 任务路由 → 生成请求配置（两任务唯一的请求配置构造点）。
 *
 * 出站身份（identity/model）与采样参数（temperature/reasoningEffort）
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
        identity: route.identity,
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
