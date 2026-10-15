/**
 * apis 域 node 冒烟：批量设置行写通道机判（scripts/smoke.mjs 以
 * APIS_PASS_EXPECTED 锁 check 计数，新增用例须同步 bump）。
 */

import { useApisStore } from './store';
import { APIS_DOMAIN_KEY, createEndpoint, deleteEndpoint, readApiDomain, setProviderNoPrefill, upsertEndpoint } from './storage';
import { TASK_PARAMS } from './task-defaults';
import { readTaskProfiles, resolveTaskRoute, setRouteForAllTasks, writeTaskProfiles } from './task-profiles';
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
            && route.url === 'https://smoke.apis-smoke/v1'
            && route.key === 'sk-apis-smoke'
            && route.model === 'm-cheap'
            && route.temperature === 1.3
            && personaRoute !== null
            && personaRoute.temperature === TASK_PARAMS.persona.defaultTemperature
            && personaRoute.reasoningEffort === 'low',
        `choice=${route ? `${route.model}@${route.url}，t=${route.temperature}` : 'null'}；persona=${personaRoute ? `${personaRoute.model}@${personaRoute.url}，t=${personaRoute.temperature}，effort=${personaRoute.reasoningEffort}` : 'null'}`,
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

    if (failures.length > 0) {
        console.error(`[apis-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[apis-smoke] OK：批量设置行与能力记忆九断言（两行齐换/调参档保留/出站跟随/写穿 revision/删站收尾/noPrefill 归一兼容/路由带出 providerId 与 noPrefill/记忆复位写穿＋revision 精确自增/悬空与重复写入静默）');
}
