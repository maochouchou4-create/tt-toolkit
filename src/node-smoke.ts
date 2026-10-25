/**
 * node 冒烟编排（无 DOM，scripts/smoke.mjs 驱动）串行链：
 * initStorage() → host 探测清单 + storage roundtrip → nav 最小初始化 →
 * nav dump → initChoiceMinimal()（不挂 DOM 的最小初始化）→
 * installPromptsPort() → runChoiceSmoke() → initApis()（域装载）→
 * initPersonaMinimal() → runPersonaSmoke()（提示词引擎/纯函数/api 形状/
 * 端到端/复核回合）→ runApisSmoke()（apis 域机判收尾：十断言，批量设置行
 * 两行齐换，夹具自持清场）→ boot 收尾标记（消费侧等待面）。
 *
 * 独立成件（批 A 发布件分块）：经入口动态 import 按需加载——浏览器分支
 * 永不触达该分支，冒烟机判与全部夹具因此不进浏览器加载面；node 侧加载
 * 的仍是同一构建图的产物，「测的就是发布件」不丢。boot 标识恒 boot1：
 * 二次启动由 scripts/smoke.mjs 以全新子进程实现，两次启动靠进程边界
 * 区分而非 query；收参只为收尾标记行的语义自述。node 下 @sillytavern
 * 外置导入由冒烟脚本的 loader 存根承载，真实宿主在场性归浏览器验收。
 */
// 冒烟机判不经模块门面直取：人设冒烟反向依赖壳的 tab 描述符（壳钩子断言），
// 门面一旦透出冒烟入口，壳消费门面即与冒烟成环（环门禁会红）。
import { formatProbeResults, probeHost } from '@/host';
import { toolkitGlobalPort } from '@/global-port';
import { dumpStorage, runStorageRoundtrip } from '@/storage/debug';
import { initStorage } from '@/storage';
import { initChoiceMinimal } from '@/modules/choice';
import { runChoiceSmoke } from '@/modules/choice/smoke';
import { initNavMinimal } from '@/modules/nav';
import { initApis } from '@/modules/apis';
import { runApisSmoke } from '@/modules/apis/smoke';
import { initPersonaMinimal } from '@/modules/persona';
import { runPersonaSmoke } from '@/modules/persona/smoke';
import { installPromptsPort, installStoragePort } from '@/ports';
import { version } from '@/version';

export async function runNodeSmoke(bootId: string): Promise<void> {
    console.info(`[tt-toolkit] node 冒烟模式 v${version}（无 DOM；真实宿主在场性归浏览器验收）`);
    initStorage();
    installStoragePort();
    console.info('=== host API 探测清单 ===');
    console.info(formatProbeResults(probeHost()));
    console.info('=== storage 写读 roundtrip ===');
    const reports = runStorageRoundtrip();
    for (const r of reports) {
        console.info(`[roundtrip:${r.scope}] ${r.ok ? 'PASS' : 'FAIL'} written=${r.written} readBack=${r.readBack} @ ${r.at}`);
    }
    console.info('=== storage 快照 ===');
    console.info(dumpStorage());
    initNavMinimal();
    const nav = toolkitGlobalPort().nav as { version?: string; dump?: () => string } | undefined;
    if (nav) {
        console.info(`=== nav dump（${nav.version ?? '?'}）===`);
        console.info(typeof nav.dump === 'function' ? nav.dump() : '（dump 不可用）');
    } else {
        console.warn('=== nav 模块未初始化（__TT_TOOLKIT__.nav 不在场）===');
    }
    initChoiceMinimal();
    installPromptsPort();
    // 组装纯函数路径＋解析回退确定性触发（断言在 smoke.mjs 收口）
    await runChoiceSmoke();
    // 统一端点域装载（apis 域读写走 storage 懒归一，无启动期写面）
    initApis();
    // 纯函数＋store 互斥＋端到端（断言在 smoke.mjs 收口）
    initPersonaMinimal();
    await runPersonaSmoke();
    // apis 域机判收尾（十断言，批量写两行齐换；夹具自持清场，置于末位不扰动前序域）
    runApisSmoke();
    // boot 收尾标记（唯一出口信号）：「这一轮跑完了没有」只能由生产侧回答。
    // 消费侧若拿 OK：/N 项 FAIL： 之类正文行去猜，任一模块提前出红就会把
    // 等待判据误触发——断言抢在本串行链跑完前开跑，boot2 与未收尾的 boot1
    // 并发共用同一份宿主存根，真 FAIL 落在计数区间之外，计出 FAIL 0 条的
    // 假绿。标记置于最后一个模块 await 之后，消费侧只认它、等不到即硬失败。
    console.info(`[node-smoke] BOOT DONE boot=${bootId}`);
}
