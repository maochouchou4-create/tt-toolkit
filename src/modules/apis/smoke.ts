/**
 * apis 域 node 冒烟：批量设置行写通道机判（scripts/smoke.mjs 以
 * APIS_PASS_EXPECTED 锁 check 计数，新增用例须同步 bump）。
 */

import { useApisStore } from './store';
import { APIS_DOMAIN_KEY, createEndpoint, deleteEndpoint, readApiDomain, setProviderNoPrefill, upsertEndpoint } from './storage';
import { TASK_PARAMS } from './task-defaults';
import {
    FOLLOW_TAVERN_KEY, readFollowStatus, readFollowTavern, readTaskProfiles, resolveTaskRoute,
    routeToRequestConfig, routeUnavailableMessage, setRouteForAllTasks, writeFollowTavern, writeTaskProfiles,
} from './task-profiles';
import { buildGenerateBody } from './client';
import { TASK_IDS } from '@/tasks';
import { setGlobal } from '@/storage/service';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
    console.info(`[apis-smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

export function runApisSmoke(): void {
    console.info('=== apis 批量设置行机判 ===');

    // 夹具自持收尾：deleteEndpoint 在末断言联动清场，boot2 重跑零依赖前置状态
    const P = createEndpoint('批量冒烟站');
    upsertEndpoint({ ...P, url: 'https://smoke.apis-smoke/v1', key: 'sk-apis-smoke', models: ['m-cheap', 'm-strong2'] });
    writeTaskProfiles({
        choice: { providerId: P.id, model: 'm-strong', temperature: 1.3 },
        persona: { providerId: P.id, model: 'm-strong', reasoningEffort: 'low' },
    });

    setRouteForAllTasks(P.id, 'm-cheap');
    const afterBatch = readTaskProfiles();
    check(
        '批量写通道两行齐换',
        TASK_IDS.every(id => afterBatch[id].providerId === P.id && afterBatch[id].model === 'm-cheap'),
        TASK_IDS.map(id => `${id}=${afterBatch[id].providerId}/${afterBatch[id].model}`).join('，'),
    );

    check(
        '调参档保留',
        afterBatch.choice.temperature === 1.3 && afterBatch.persona.reasoningEffort === 'low',
        `choice.temperature=${afterBatch.choice.temperature}，persona.reasoningEffort=${afterBatch.persona.reasoningEffort}`,
    );

    const route = resolveTaskRoute('choice');
    const personaRoute = resolveTaskRoute('persona');
    check(
        '出站路由跟随批量行',
        route !== null
            && route.identity.kind === 'provider'
            && route.identity.url === 'https://smoke.apis-smoke/v1'
            && route.identity.key === 'sk-apis-smoke'
            && route.model === 'm-cheap'
            && route.temperature === 1.3
            && personaRoute !== null
            && personaRoute.temperature === TASK_PARAMS.persona.defaultTemperature
            && personaRoute.reasoningEffort === 'low',
        `choice=${route ? `${route.model}@${route.identity.kind === 'provider' ? route.identity.url : 'host'}，t=${route.temperature}` : 'null'}；persona=${personaRoute ? `${personaRoute.model}@${personaRoute.identity.kind === 'provider' ? personaRoute.identity.url : 'host'}，t=${personaRoute.temperature}，effort=${personaRoute.reasoningEffort}` : 'null'}`,
    );

    const store = useApisStore();
    const revisionBase = store.revision;
    store.applyRouteToAllTasks(P.id, 'm-strong2');
    const afterStore = readTaskProfiles();
    check(
        'store 批量写口写穿＋revision 自增',
        TASK_IDS.every(id => afterStore[id].model === 'm-strong2') && store.revision - revisionBase >= 1,
        `revision ${revisionBase}→${store.revision}`,
    );

    deleteEndpoint(P.id);
    const afterDelete = readTaskProfiles();
    check(
        '删服务商联动重置（boot2 幂等前提）',
        TASK_IDS.every(id => afterDelete[id].providerId === '' && afterDelete[id].model === ''),
        TASK_IDS.map(id => `${id}=${afterDelete[id].providerId}/${afterDelete[id].model}`).join('，'),
    );

    // noPrefill 能力记忆（归一/带出/写穿三断言；夹具照旧自持，末尾复位清理）
    // ① 老档兼容：缺 noPrefill 字段的存量条目读侧归一为 false，显式 true 往返不丢
    const legacy = { ...P, url: 'https://smoke.apis-np/v1' };
    delete (legacy as { noPrefill?: boolean }).noPrefill;
    setGlobal(APIS_DOMAIN_KEY, [legacy]);
    const legacyRead = readApiDomain()[0]?.noPrefill;
    setProviderNoPrefill(P.id, true);
    check(
        'noPrefill 归一：老档缺字段归 false、显式 true 往返不丢',
        legacyRead === false && readApiDomain()[0]?.noPrefill === true,
        `缺字段读回=${String(legacyRead)}，写入 true 读回=${String(readApiDomain()[0]?.noPrefill)}`,
    );
    writeTaskProfiles({ ...readTaskProfiles(), choice: { providerId: P.id, model: 'm-strong2' } });

    // ② 唯一解析点带出 providerId 与 noPrefill
    const npRoute = resolveTaskRoute('choice');
    check(
        '出站路由带出 providerId 与 noPrefill',
        npRoute !== null && npRoute.providerId === P.id && npRoute.noPrefill === true,
        `providerId=${npRoute?.providerId ?? 'null'}，noPrefill=${String(npRoute?.noPrefill)}`,
    );

    // ③ store 记忆/复位两动作写穿＋revision 精确自增（值没变的写入不得惊动消费面）
    const npStore = useApisStore();
    const npRevisionBase = npStore.revision;
    npStore.resetPrefillCapability(P.id);
    const afterReset = readApiDomain()[0];
    npStore.markPrefillUnsupported(P.id);
    const afterMark = readApiDomain()[0];
    check(
        'store 记忆/复位写穿＋revision 精确自增',
        afterReset?.noPrefill === false && afterMark?.noPrefill === true
            && npStore.revision - npRevisionBase === 2
            && readApiDomain().length === 1 && readApiDomain()[0]?.id === P.id,
        `复位后=${String(afterReset?.noPrefill)}，标记后=${String(afterMark?.noPrefill)}，revision ${npRevisionBase}→${npStore.revision}`,
    );

    // ④ 写穿但无实际改动时必须静默：悬空 providerId（生成中被删的合法并发态）
    // 与已处目标值的重复写入都不得 bump revision——否则每次重复学习/复位都会
    // 让 API 页与各任务行整域重算（当前服务商处于已标记态：重复标记无改动，
    // 重复复位则是真改动，只能留给收尾清理）
    const revBeforeNoop = npStore.revision;
    const domainBeforeNoop = JSON.stringify(readApiDomain());
    npStore.markPrefillUnsupported('no-such-provider');
    npStore.markPrefillUnsupported(P.id);
    check(
        '悬空/重复能力写入静默（revision 与服务商域均不变）',
        npStore.revision === revBeforeNoop && JSON.stringify(readApiDomain()) === domainBeforeNoop,
        `revision ${revBeforeNoop}→${npStore.revision}，域=${JSON.stringify(readApiDomain())}`,
    );

    setProviderNoPrefill(P.id, false);
    deleteEndpoint(P.id);

    // 请求配置构造器（两任务唯一出口）：身份与采样参数逐字段取自路由，
    // 流式/输出契约/超时按任务固化档。超时这项钉住的是「任务档进了请求」
    // ——它必填且不给默认，少写就是一次可能永挂的请求。
    const cfgChoice = routeToRequestConfig('choice', {
        providerId: 'tp-c', identity: { kind: 'provider', url: 'https://cfg.example.com/v1', key: 'sk-cfg' },
        model: 'm-cfg', temperature: 1.3, reasoningEffort: 'low', noPrefill: false,
    });
    const cfgPersona = routeToRequestConfig('persona', {
        providerId: 'tp-p', identity: { kind: 'provider', url: 'https://cfg.example.com/v1', key: 'sk-cfg' },
        model: 'm-cfg', temperature: 0.7, reasoningEffort: 'high', noPrefill: false,
    });
    check(
        '请求配置构造器：两任务同形（身份与采样参数随路由、流式/契约/超时按 TASK_PARAMS、不发 max_tokens）',
        cfgChoice.task === 'choice'
        && cfgChoice.identity.kind === 'provider' && cfgChoice.identity.url === 'https://cfg.example.com/v1' && cfgChoice.identity.key === 'sk-cfg'
        && cfgChoice.model === 'm-cfg' && cfgChoice.temperature === 1.3 && cfgChoice.reasoningEffort === 'low'
        && cfgChoice.stream === TASK_PARAMS.choice.stream && cfgChoice.outputContract === TASK_PARAMS.choice.outputContract
        && cfgChoice.timeoutSec === TASK_PARAMS.choice.timeoutSec && cfgChoice.timeoutSec === 300
        && cfgPersona.task === 'persona' && cfgPersona.temperature === 0.7 && cfgPersona.reasoningEffort === 'high'
        && cfgPersona.stream === TASK_PARAMS.persona.stream && cfgPersona.outputContract === TASK_PARAMS.persona.outputContract
        && cfgPersona.timeoutSec === TASK_PARAMS.persona.timeoutSec && cfgPersona.timeoutSec === 600
        && !('max_tokens' in buildGenerateBody([{ role: 'user', content: 'hi' }], cfgChoice))
        && !('max_tokens' in buildGenerateBody([{ role: 'user', content: 'hi' }], cfgPersona)),
        `choice=${JSON.stringify(cfgChoice)}；persona=${JSON.stringify(cfgPersona)}`,
    );

    runFollowChecks();

    if (failures.length > 0) {
        console.error(`[apis-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[apis-smoke] OK：批量设置行与能力记忆十断言（两行齐换/调参档保留/出站跟随/写穿 revision/删站收尾/noPrefill 归一兼容/路由带出 providerId 与 noPrefill/记忆复位写穿＋revision 精确自增/悬空与重复写入静默/请求配置构造器两任务同形与不发 max_tokens）＋跟随四断言（键归一坏值/跟随态路由与请求体/挡源 fail fast 与文案/状态快照三态与复位幂等）');
}

/** 冒烟 stub 访问（scripts/smoke.mjs 注入；类型只声明本文件用到的面）。 */
interface FollowSmokeStubs {
    getContext(): {
        chatCompletionSettings: Record<string, string>;
        mainApi: string;
    };
}

function followSmokeStubs(): FollowSmokeStubs | null {
    return (globalThis as { __TT_SMOKE_STUBS__?: FollowSmokeStubs }).__TT_SMOKE_STUBS__ ?? null;
}

/**
 * 跟随开关机判：键归一坏值、跟随态路由（忽略档案行、调参档仍生效）、
 * 请求体两态组装（custom_url 原样/反代原样不走 normalizeApiUrl）、挡源
 * fail fast 与挡因文案、状态快照三态、收尾复位（boot2 幂等）。
 */
function runFollowChecks(): void {
    const stubs = followSmokeStubs();
    if (!stubs) {
        check('跟随：冒烟 stub 在场', false, '__TT_SMOKE_STUBS__ 缺席（应由 scripts/smoke.mjs 注入）');
        return;
    }
    const conn = stubs.getContext().chatCompletionSettings;

    // ① 键归一：非布尔坏值读为关（类型面只收 boolean，坏值模拟须绕过类型——
    // 存档真实世界不受类型保护）
    setGlobal(FOLLOW_TAVERN_KEY, 'yes' as unknown as boolean);
    check('跟随键归一：非布尔坏值读为关', readFollowTavern() === false, `读回=${String(readFollowTavern())}`);

    // ② 跟随开＋custom 缺地址 → 判挡 fail fast，文案指名真因
    writeFollowTavern(true);
    conn.custom_url = '';
    conn.custom_model = 'm-follow';
    const blockedRoute = resolveTaskRoute('choice');
    const blockedMsg = routeUnavailableMessage('choice');
    check(
        '跟随挡：custom 缺地址 fail fast 且文案指名',
        blockedRoute === null && blockedMsg.includes('自定义端点未填地址') && readFollowStatus().ok === false,
        `route=${String(blockedRoute)}，msg=${blockedMsg}`,
    );

    // ③ 跟随开＋可跟（custom 源填地址选模型）→ host 路由：忽略档案行
    // （服务商已删、档案行未配置），调参档仍按任务默认
    conn.custom_url = 'https://follow.example/v1';
    const followRoute = resolveTaskRoute('choice');
    check(
        '跟随态路由：镜像宿主连接、忽略档案行、调参档仍生效',
        followRoute !== null
            && followRoute.providerId === ''
            && followRoute.identity.kind === 'host'
            && followRoute.identity.source === 'custom'
            && followRoute.identity.customUrl === 'https://follow.example/v1'
            && followRoute.model === 'm-follow'
            && followRoute.noPrefill === false
            && followRoute.temperature === TASK_PARAMS.choice.defaultTemperature
            && followRoute.reasoningEffort === TASK_PARAMS.choice.defaultReasoningEffort,
        `route=${followRoute ? JSON.stringify(followRoute) : 'null'}`,
    );

    // ④ host 态请求体：源/custom_url 原样直发（custom 不在反代白名单，
    // reverse_proxy 即使非空也不发——镜像宿主组装条件）
    if (followRoute) {
        conn.reverse_proxy = 'https://rp.example/';
        conn.proxy_password = 'sk-rp';
        const followBody = buildGenerateBody([{ role: 'user', content: 'hi' }], routeToRequestConfig('choice', followRoute));
        check(
            '跟随态请求体：custom 源 custom_url 原样、反代不随发',
            followBody.chat_completion_source === 'custom'
            && followBody.custom_url === 'https://follow.example/v1'
            && !('reverse_proxy' in followBody) && !('proxy_password' in followBody)
            && followBody.model === 'm-follow' && followBody.type === 'quiet',
            `body=${JSON.stringify(followBody)}`,
        );

        // ⑤ openai 源＋反代：反代地址原样直发（不走 normalizeApiUrl 补 /v1
        // ——宿主里填的是完整反代端点），密钥经 proxy_password 通道
        conn.chat_completion_source = 'openai';
        conn.openai_model = 'gpt-follow';
        const proxyRoute = resolveTaskRoute('choice');
        const proxyBody = proxyRoute
            ? buildGenerateBody([{ role: 'user', content: 'hi' }], routeToRequestConfig('choice', proxyRoute))
            : null;
        check(
            '跟随态请求体：openai 源反代原样直发（不补 /v1）',
            proxyBody !== null
            && proxyBody.chat_completion_source === 'openai'
            && proxyBody.reverse_proxy === 'https://rp.example/'
            && proxyBody.proxy_password === 'sk-rp'
            && !('custom_url' in proxyBody)
            && proxyBody.model === 'gpt-follow',
            `body=${proxyBody ? JSON.stringify(proxyBody) : 'null'}`,
        );

        // ⑥ 挡源：claude 官方源 → null＋挡因文案点名，状态快照同步报挡
        conn.chat_completion_source = 'claude';
        conn.claude_model = 'c-follow';
        const claudeRoute = resolveTaskRoute('choice');
        const claudeStatus = readFollowStatus();
        check(
            '跟随挡：claude 官方源 fail fast、挡因与状态行点名',
            claudeRoute === null
            && routeUnavailableMessage('choice').includes('Claude')
            && claudeStatus.on === true && claudeStatus.ok === false && claudeStatus.text.includes('Claude'),
            `route=${String(claudeRoute)}，status=${JSON.stringify(claudeStatus)}`,
        );
    }

    // ⑦ 收尾复位：开关关＋存根连接复原——boot2 重跑零依赖前置状态
    writeFollowTavern(false);
    conn.chat_completion_source = 'custom';
    conn.custom_url = '';
    conn.custom_model = '';
    conn.reverse_proxy = '';
    conn.proxy_password = '';
    conn.openai_model = '';
    conn.claude_model = '';
    const offStatus = readFollowStatus();
    check(
        '跟随复位：关态三件归位（boot2 幂等前提）',
        readFollowTavern() === false
            && resolveTaskRoute('choice') === null
            && offStatus.on === false && offStatus.ok === true,
        `follow=${String(readFollowTavern())}，status=${JSON.stringify(offStatus)}`,
    );
}
