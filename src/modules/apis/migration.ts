/**
 * 统一端点表一次性迁移：收编 choice 旧 apis[] 与 persona 旧
 * localConfig 端点字段进统一表，并把选中端点重映射到全局活动键
 * （extension_settings.ttToolkit.activeEndpointId——v1.4.0 起端点选择
 * 收归全局单键，choice/persona 任务域选中字段全部退役）。
 *
 * persona 收编读源＝legacy 快照键 pw_state_v20（只读不写——快照保留
 * 纪律，域侧 localConfig 已随任务参数固化退役，过渡字段不再经域透传）。
 * 快照不可变、不能当增量信号，幂等终点（二次启动零重写）由统一表与
 * 全局活动键的在场判定：两者在场且 choice 旧字段已清＝skip。
 *
 * 幂等口径：统一表在场、choice 域旧字段已清且全局活动键已落位＝skip。
 * 统一表在场但 choice 旧字段仍在（v1 存档未重写）＝继续收编，去重后
 * 并入既有表，不重复不丢失。全局活动键提升独立幂等：键缺席才写
 * （值取 choice 侧旧选中——choice 是主功能，persona 旧 endpointId 不
 * 参与提升），键已落位后旧任务域字段不再回读。
 *
 * 去重规则：normalizeApiUrl(url).toLowerCase() + model 为同一端点；choice
 * 侧优先（先收），persona 侧命中同键＝并入既有条目（mergedDuplicates）。
 * id 规则：choice 侧 id 原样保留；persona 侧 id 保留，撞既有 id 且非同一
 * 端点时重分配新 id 并记录 idRemaps。
 */

import { getGlobal, setGlobal } from '@/storage/service';
import { newId } from '@/storage';
import { normalizeApiUrl } from './client';
import { ACTIVE_ENDPOINT_KEY, APIS_DOMAIN_KEY, readApiDomain, setActiveEndpointId, writeApiDomain } from './storage';
import type { ApiEndpoint } from './types';
import { GLOBAL_CHOICE_KEY } from '@/modules/choice/api';
import { LEGACY_KEYS, PERSONA_DOMAIN_KEY, readPersonaDomain } from '@/modules/persona/storage';

const DEFAULT_INDEP_URL = 'https://api.openai.com/v1';
const DEFAULT_INDEP_MODEL = 'gpt-3.5-turbo';

/** 迁移报告（smoke 断言收编零丢失/二次零重写用）。 */
export interface ApiMigrationReport {
    /** 统一表在场且两侧旧字段已清（本次无任何写）。 */
    skipped: boolean;
    /** 实际收到数据的来源（'choice' / 'persona'）。 */
    collectedFrom: string[];
    /** persona 端点 id 撞车重分配映射（旧 id → 新 id）。 */
    idRemaps: Array<{ from: string; to: string }>;
    /** 去重命中数（后来侧并入既有端点的条数）。 */
    mergedDuplicates: number;
    /** 收编后统一端点表条数。 */
    endpointCount: number;
    /** 全局活动端点键本次提升落位（键缺席才发生——一次性）。 */
    activeEndpointPromoted: boolean;
}

/** 去重键（同一 url+model 视为同一端点；url 归一后比较，模型 id 区分大小写）。 */
function endpointKey(url: string, model: string): string {
    return `${normalizeApiUrl(url).toLowerCase()}\n${model.trim()}`;
}

function newEndpointId(): string {
    return newId('endpoint');
}

/** 旧 choice ApiConfig（v1 域形状；端点身份同居，任务参数已固化不收）。 */
interface LegacyChoiceApi {
    id: string;
    name: string;
    apiurl: string;
    key: string;
    model: string;
}

function readLegacyChoiceApis(raw: unknown): LegacyChoiceApi[] {
    const domain = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!Array.isArray(domain.apis)) return [];
    return domain.apis.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const r = item as Record<string, unknown>;
        const id = typeof r.id === 'string' ? r.id : '';
        // 无 id/url＝坏档，不收（保真纪律：坏条目剔除而非猜测补全）
        if (!id || typeof r.apiurl !== 'string') return [];
        return [{
            id,
            name: typeof r.name === 'string' ? r.name : '未命名端点',
            apiurl: r.apiurl,
            key: typeof r.key === 'string' ? r.key : '',
            model: typeof r.model === 'string' ? r.model : '',
        }];
    });
}

/** persona 侧收编原料（旧 localConfig 端点字段，legacy 快照 raw 形态消费）。 */
interface PersonaLegacyApi {
    profiles: Array<{ id: string; name: string; url: string; key: string; model: string }>;
    custom: { id: string; name: string; url: string; key: string; model: string } | null;
}

function readPersonaLegacyApi(): PersonaLegacyApi | null {
    // 读 legacy 快照键（migratePersonaDomain 的保留纪律：只读不写）；
    // 不经 PersonaDomain 类型——域已无 localConfig，过渡字段只在快照里
    let savedState: Record<string, unknown> = {};
    try {
        const raw = globalThis.localStorage?.getItem(LEGACY_KEYS.state);
        const parsed: unknown = raw ? JSON.parse(raw) : undefined;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) savedState = parsed as Record<string, unknown>;
    } catch {
        return null;
    }
    const local = (savedState.localConfig && typeof savedState.localConfig === 'object'
        ? savedState.localConfig
        : {}) as Record<string, unknown>;

    const profiles = Array.isArray(local.apiProfiles)
        ? local.apiProfiles.flatMap(item => {
            if (!item || typeof item !== 'object') return [];
            const r = item as Record<string, unknown>;
            const id = typeof r.id === 'string' ? r.id : '';
            if (!id) return [];
            return [{
                id,
                name: typeof r.name === 'string' ? r.name : '未命名配置',
                url: typeof r.url === 'string' ? r.url : '',
                key: typeof r.key === 'string' ? r.key : '',
                model: typeof r.model === 'string' ? r.model : '',
            }];
        })
        : [];
    const activeProfileId = typeof local.activeApiProfileId === 'string' ? local.activeApiProfileId : 'custom';
    const customUrl = typeof local.indepApiUrl === 'string' ? local.indepApiUrl : '';
    const customKey = typeof local.indepApiKey === 'string' ? local.indepApiKey : '';
    const customModel = typeof local.indepApiModel === 'string' ? local.indepApiModel : '';

    // 「当前独立 API」现值只在直用 custom 档时是活数据（选中配置档时表单值
    // 只是档案镜像）；纯默认占位值不收（收了只是噪声端点）
    const meaningfulCustom = activeProfileId === 'custom'
        && customUrl.trim() !== ''
        && (customUrl.trim() !== DEFAULT_INDEP_URL || customKey.trim() !== ''
            || (customModel.trim() !== '' && customModel.trim() !== DEFAULT_INDEP_MODEL));

    // 无任何端点旧字段＝persona 侧无事可做
    if (profiles.length === 0 && !meaningfulCustom && local.apiSource === undefined) return null;

    return {
        profiles,
        custom: meaningfulCustom
            ? { id: newEndpointId(), name: '当前独立 API', url: customUrl, key: customKey, model: customModel }
            : null,
    };
}

export function migrateApiDomain(): ApiMigrationReport {
    const report: ApiMigrationReport = { skipped: false, collectedFrom: [], idRemaps: [], mergedDuplicates: 0, endpointCount: 0, activeEndpointPromoted: false };

    const rawChoice = getGlobal(GLOBAL_CHOICE_KEY);
    const choiceDomain = (rawChoice && typeof rawChoice === 'object' ? rawChoice : null) as Record<string, unknown> | null;
    const legacyChoiceApis = readLegacyChoiceApis(rawChoice);
    const personaLegacy = readPersonaLegacyApi();
    const unifiedPresent = getGlobal(APIS_DOMAIN_KEY) !== undefined;
    const globalActivePresent = getGlobal(ACTIVE_ENDPOINT_KEY) !== undefined;

    // persona 快照不可变，不能当增量信号——统一表＋全局键在场即视为已收编
    // （choice 侧仍看域内 apis[]：v1 存档未重写前它就是增量信号）
    if (unifiedPresent && globalActivePresent && legacyChoiceApis.length === 0 && !choiceDomain?.apis) {
        report.skipped = true;
        report.endpointCount = readApiDomain().length;
        return report;
    }

    // ---- 收编（choice 侧优先） ----
    const endpoints = readApiDomain();  // 自愈场景＝既有表打底
    const seen = new Map<string, string>();  // 去重键 → 端点 id
    for (const e of endpoints) seen.set(endpointKey(e.url, e.model), e.id);

    /** 把一条旧端点并入表：去重命中＝记映射并入；id 撞车＝重分配。 */
    const ingest = (entry: { id: string; name: string; url: string; key: string; model: string }, fromPersona: boolean): string => {
        const key = endpointKey(entry.url, entry.model);
        const existingId = seen.get(key);
        if (existingId !== undefined) {
            report.mergedDuplicates += 1;
            return existingId;
        }
        if (endpoints.some(e => e.id === entry.id)) {
            // id 撞车但非同一端点：persona 侧重分配；choice 侧在此场景意味着
            // 表里已有同 id 异键端点（数据异常），同样重分配保唯一
            const remapped = newEndpointId();
            if (fromPersona) report.idRemaps.push({ from: entry.id, to: remapped });
            const endpoint: ApiEndpoint = { id: remapped, name: entry.name, url: entry.url, key: entry.key, model: entry.model };
            endpoints.push(endpoint);
            seen.set(key, remapped);
            return remapped;
        }
        const endpoint: ApiEndpoint = { id: entry.id, name: entry.name, url: entry.url, key: entry.key, model: entry.model };
        endpoints.push(endpoint);
        seen.set(key, entry.id);
        return entry.id;
    };

    // choice 侧：id→统一表 id 映射（去重时旧 id 指向并入目标）
    const choiceIdMap = new Map<string, string>();
    for (const api of legacyChoiceApis) {
        choiceIdMap.set(api.id, ingest({ id: api.id, name: api.name, url: api.apiurl, key: api.key, model: api.model }, false));
    }
    if (legacyChoiceApis.length > 0) report.collectedFrom.push('choice');

    // persona 侧（只收编进表；选中不再重映射——端点选择归全局键）
    if (personaLegacy) {
        for (const profile of personaLegacy.profiles) {
            ingest(profile, true);
        }
        if (personaLegacy.custom) {
            ingest(personaLegacy.custom, true);
        }
        report.collectedFrom.push('persona');
    }

    // ---- 落表 ----
    writeApiDomain(endpoints);
    report.endpointCount = endpoints.length;

    // ---- 全局活动端点提升（键缺席才写，choice 侧优先） ----
    let resolvedActiveId = '';
    if (legacyChoiceApis.length > 0) {
        // v1 存档：activeApiId 重映射进统一表（缺省取首条，与旧口径一致）
        const activeRaw = typeof choiceDomain?.activeApiId === 'string' ? choiceDomain.activeApiId.trim() : '';
        const active = legacyChoiceApis.find(a => a.id === activeRaw) ?? legacyChoiceApis[0] ?? null;
        resolvedActiveId = active ? choiceIdMap.get(active.id) ?? '' : '';
    } else if (typeof choiceDomain?.activeEndpointId === 'string') {
        // v1.3 存量：choice 任务域旧选中键直接提升（persona 旧 endpointId 不参与）
        resolvedActiveId = choiceDomain.activeEndpointId;
    }
    if (!globalActivePresent) {
        setActiveEndpointId(resolvedActiveId);
        report.activeEndpointPromoted = true;
    }

    // ---- choice 域 v2 重写（仅 v1 存档：旧 apis/activeApiId 收编落定后
    // 整键重写退休旧字段——normalize 丢弃面在下次读时洗掉 task 等遗留键；
    // v1.3 存量的 choice 域已是 v2 形状，不经此路径） ----
    if (choiceDomain && legacyChoiceApis.length > 0) {
        setGlobal(GLOBAL_CHOICE_KEY, {
            gen: choiceDomain.gen ?? undefined,
            pool: choiceDomain.pool ?? undefined,
        });
    }

    // ---- persona 域 v2 重写（幂等清洗＝旧档 localConfig 键的退休路径：
    // 整键重写落 normalize 新形状，localConfig 及一切遗留键被丢弃面洗掉） ----
    if (personaLegacy) {
        setGlobal(PERSONA_DOMAIN_KEY, readPersonaDomain());
    }

    return report;
}
