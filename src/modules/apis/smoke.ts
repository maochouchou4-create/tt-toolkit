/**
 * apis 域 node 冒烟：批量设置行写通道机判（scripts/smoke.mjs 以
 * APIS_PASS_EXPECTED 锁 check 计数，新增用例须同步 bump）。
 */

import { useApisStore } from './store';
import { createEndpoint, deleteEndpoint, upsertEndpoint } from './storage';
import { TASK_PARAMS } from './task-defaults';
import { emptyTaskProfile, readTaskProfiles, resolveTaskRoute, setRouteForAllTasks, writeTaskProfiles } from './task-profiles';
import { TASK_IDS } from '@/tasks';

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
        persona: { providerId: P.id, model: 'm-strong' },
        summary_small: emptyTaskProfile(),
        summary_big: { providerId: P.id, model: 'm-strong' },
        summary_judge: { providerId: 'p-gone', model: 'm-judge-old', reasoningEffort: 'low' },
    });

    setRouteForAllTasks(P.id, 'm-cheap');
    const afterBatch = readTaskProfiles();
    check(
        '批量写通道五行齐换',
        TASK_IDS.every(id => afterBatch[id].providerId === P.id && afterBatch[id].model === 'm-cheap'),
        TASK_IDS.map(id => `${id}=${afterBatch[id].providerId}/${afterBatch[id].model}`).join('，'),
    );

    check(
        '调参档保留',
        afterBatch.choice.temperature === 1.3 && afterBatch.summary_judge.reasoningEffort === 'low',
        `choice.temperature=${afterBatch.choice.temperature}，summary_judge.reasoningEffort=${afterBatch.summary_judge.reasoningEffort}`,
    );

    const route = resolveTaskRoute('summary_small');
    const judgeRoute = resolveTaskRoute('summary_judge');
    check(
        '出站路由跟随批量行',
        route !== null
            && route.url === 'https://smoke.apis-smoke/v1'
            && route.key === 'sk-apis-smoke'
            && route.model === 'm-cheap'
            && route.temperature === TASK_PARAMS.summary_small.defaultTemperature
            && judgeRoute !== null
            && judgeRoute.reasoningEffort === 'low',
        `summary_small=${route ? `${route.model}@${route.url}，t=${route.temperature}` : 'null'}；summary_judge.effort=${judgeRoute?.reasoningEffort ?? 'null'}`,
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

    if (failures.length > 0) {
        console.error(`[apis-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[apis-smoke] OK：批量设置行五断言（五行齐换/调参档保留/出站跟随/写穿 revision/删站收尾）');
}
