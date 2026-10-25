/**
 * 扩展引导：唯一环境分支点（模块不自行探测环境自启动）。
 *
 * 浏览器（TT 宿主窗口）流：initStorage() → mountShell() → registerTab×4
 * → initChoice()（提示词配置落盘＋选项条挂载＋MESSAGE_RECEIVED
 * 自动生成监听）→ installPromptsPort()（__TT_TOOLKIT__.prompts 排障口，
 * 按任务键分派 choice/persona 两侧）
 * → initNav() → initApis()（统一端点表：persona 域迁移先成型，再收编
 * choice/persona 旧 API 字段）→ initPersona() → retireSummaryKeys()（退役
 * 域键删除）→ wipeLegacyKeysOnce()（遗留
 * localStorage 键一次性清理——顺序硬约束，必须位于全部幂等迁移之后）。
 * node 冒烟（无 DOM，scripts/smoke.mjs 驱动）流：initStorage() → host
 * 探测清单 + storage roundtrip → nav 最小初始化 → nav dump。
 * initChoiceMinimal()（默认配置落盘，不挂 DOM）→ installPromptsPort()
 * → runChoiceSmoke()
 * → initApis() → initPersonaMinimal() → wipeLegacyKeysOnce() ＋
 * runLegacyWipeSmoke()（机判须先于 runPersonaSmoke——后者会中途回收旧键
 * 并重置 persona 域）→ runPersonaSmoke() → retireSummaryKeys() ＋
 * runRetireSummarySmoke()（退役域键删除机判：两域键缺席/二跑幂等/失败仅 warn）
 * → runApisSmoke()（apis 域机判收尾：十断言，批量设置行两行齐换，夹具自持清场）
 * → boot 收尾标记（消费侧等待面）。
 * 时序约束：storage 必须先于一切读方初始化（旧 localStorage 键迁移
 * 先于 store 首读），故初始化主权集中在此、不在各模块。
 * node 下 @sillytavern 外置导入由冒烟脚本的 loader 存根承载，
 * 真实宿主在场性归浏览器验收。
 */

// 先激活 pinia：后续命令式模块在事件回调里取 store 依赖 active 实例
import '@/pinia';
import { formatProbeResults, probeHost } from '@/host';
import { toolkitGlobalPort } from '@/global-port';
import { mountShell, registerTab } from '@/shell';
import { createApiTab, createChoiceSettingsTab, createLogTab, createPersonaTab } from '@/shell/tabs';
import { dumpStorage, runStorageRoundtrip } from '@/storage/debug';
import { initStorage } from '@/storage';
import { runLegacyWipeSmoke, wipeLegacyKeysOnce } from '@/storage/legacy-wipe';
import { retireSummaryKeys, runRetireSummarySmoke } from '@/storage/retire-summary';
// 冒烟机判不经模块门面直取：人设冒烟反向依赖壳的 tab 描述符（壳钩子断言），
// 门面一旦透出冒烟入口，壳消费门面即与冒烟成环（环门禁会红）。
import { initChoice, initChoiceMinimal, assembleCurrent, parseOptions, DEBUG_MALFORMED_RAW } from '@/modules/choice';
import { runChoiceSmoke } from '@/modules/choice/smoke';
import { initNav, initNavMinimal } from '@/modules/nav';
import { initApis } from '@/modules/apis';
import { runApisSmoke } from '@/modules/apis/smoke';
import { initPersona, initPersonaMinimal, dumpPersonaTask } from '@/modules/persona';
import { runPersonaSmoke } from '@/modules/persona/smoke';
import { TASK_KEYS, type TaskKey } from '@/prompts';
import { version } from '@/version';

/** 存储域 dump 挂入统一排障口（devtools 直取 __TT_TOOLKIT__.storage.dump()）。 */
function installStoragePort(): void {
    toolkitGlobalPort().storage = Object.freeze({ dump: dumpStorage });
}

/**
 * 提示词排障口 __TT_TOOLKIT__.prompts（dump / assemble / parseOptions）：
 * 用户浏览器验收与排障共用（与生成管线同一条组装路径）。
 *
 * 分派登记在引导层：dump 的任务键全集跨模块——choice 走组装管线，persona
 * 两任务由 persona 模块实现，两者是兄弟模块，谁都不该引对方；引导层是唯一
 * 同时持有两侧的地方。任务键全集即 dump 支持全集，键外取值给「未知任务键」报错。
 */
function installPromptsPort(): void {
    const port = {
        version,
        /**
         * 全量组装 dump（宿主真实数据；async——世界书扫描是异步的）。
         * task＝'choice'（默认）走选项生成组装；persona 任务走
         * dumpPersonaTask（运行时任务态以空呈现，模板与注入全文可见）。
         */
        async dump(task?: string | { task?: string }): Promise<string> {
            const raw = typeof task === 'string' ? task : task?.task;
            const key = TASK_KEYS.includes(raw as TaskKey) ? (raw as TaskKey) : raw === undefined ? 'choice' : undefined;
            if (!key) {
                throw new Error(`未知任务键 ${String(raw)}——可选值：${TASK_KEYS.join(' / ')}`);
            }
            const dumpText = key === 'choice'
                ? (await assembleCurrent()).dumpText
                : await dumpPersonaTask(key);
            console.info(dumpText);
            return dumpText;
        },
        /** 组装结果原始形态（消息数组＋trace；choice 任务专用口） */
        assemble: assembleCurrent,
        /** 解析纯函数（畸形输出回退路径的确定性探针） */
        parseOptions,
        /** 调试用固定畸形样本（配合 parseOptions 验证回退） */
        DEBUG_MALFORMED_RAW,
    };
    Object.freeze(port);
    toolkitGlobalPort().prompts = port;
}

/**
 * node 冒烟 boot 标识：dist 入口 URL 的 query 串——scripts/smoke.mjs 二次
 * 启动以 `dist/index.js?boot2` 作 cache-buster 整图重求值，同一份模块代码
 * 因此会跑两遍，无 query 即首启。
 */
function resolveBootId(): string {
    return new URL(import.meta.url).search.slice(1) || 'boot1';
}

async function runNodeSmoke(): Promise<void> {
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
    // 统一端点表迁移收编（persona 域先成型再收编；报告断言在 smoke.mjs）
    initApis();
    // persona 迁移幂等＋纯函数＋store 互斥（断言在 smoke.mjs 收口）
    initPersonaMinimal();
    // 遗留键一次性清理（全部幂等迁移之后；persona smoke 会回收
    // 旧键并重置 persona 域，boot 态断言必须在其前——断言在 smoke.mjs 收口）
    wipeLegacyKeysOnce();
    runLegacyWipeSmoke();
    await runPersonaSmoke();
    // 总结域退役清理（两域键删除＋幂等不炸；断言在 smoke.mjs 清理段收口）
    retireSummaryKeys();
    runRetireSummarySmoke();
    // apis 域机判收尾（十断言，批量写两行齐换；夹具自持清场，置于末位不扰动前序域）
    runApisSmoke();
    // boot 收尾标记（唯一出口信号）：「这一轮跑完了没有」只能由生产侧回答。
    // 消费侧若拿 OK：/N 项 FAIL： 之类正文行去猜，任一模块提前出红就会把
    // 等待判据误触发——断言抢在本串行链跑完前开跑，boot2 与未收尾的 boot1
    // 并发共用同一份宿主存根，真 FAIL 落在计数区间之外，计出 FAIL 0 条的
    // 假绿。标记置于最后一个模块 await 之后，消费侧只认它、等不到即硬失败。
    console.info(`[node-smoke] BOOT DONE boot=${resolveBootId()}`);
}

async function main(): Promise<void> {
    if (typeof document === 'undefined') {
        await runNodeSmoke();
        return;
    }
    initStorage();
    installStoragePort();
    mountShell();
    registerTab(createChoiceSettingsTab());
    registerTab(createApiTab());
    registerTab(createPersonaTab());
    registerTab(createLogTab());
    initChoice();
    installPromptsPort();
    initNav();
    // 统一端点表：persona 域迁移先成型（initApis 内先 migratePersonaDomain），
    // 再收编 choice/persona 旧 API 字段——顺序敏感，勿调换
    initApis();
    initPersona();
    // 总结域退役清理：删全局域与当前聊天的 summary 键（幂等每次启动跑）
    retireSummaryKeys();
    // 遗留 localStorage 键一次性清理——位于全部幂等迁移之后
    // （迁移消费在先、删除在后，绝不碰已迁移数据），见 storage/legacy-wipe
    wipeLegacyKeysOnce();
    console.info(`[tt-toolkit] v${version} ready (rewrite)`);
}

void main();
