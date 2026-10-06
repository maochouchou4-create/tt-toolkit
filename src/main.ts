/**
 * 扩展引导：唯一环境分支点（模块不自行探测环境自启动）。
 *
 * 浏览器（TT 宿主窗口）流：initStorage() → mountShell() → registerTab×5
 * （含 API 页）→ initChoice()（提示词配置落盘＋__TT_TOOLKIT__.prompts
 * 全局口＋选项条挂载＋MESSAGE_RECEIVED 自动生成监听）
 * → initNav() → initApis()（统一端点表：persona 域迁移先成型，再收编
 * choice/persona 旧 API 字段）→ initPersona() → wipeLegacyKeysOnce()（遗留
 * localStorage 键一次性清理——顺序硬约束，必须位于全部幂等迁移之后）。
 * node 冒烟（无 DOM，scripts/smoke.mjs 驱动）流：initStorage() → host
 * 探测清单 + storage roundtrip → nav 最小初始化 → nav dump。
 * initChoiceMinimal()（默认配置落盘＋全局口，不挂 DOM）→ runChoiceSmoke()
 * → initApis() → initPersonaMinimal() → wipeLegacyKeysOnce() ＋
 * runLegacyWipeSmoke()（机判须先于 runPersonaSmoke——后者会中途回收旧键
 * 并重置 persona 域）→ runPersonaSmoke()。
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
import { createApiTab, createChoiceSettingsTab, createLogTab, createNavSettingsTab, createPersonaTab } from '@/shell/tabs';
import { dumpStorage, runStorageRoundtrip } from '@/storage/debug';
import { initStorage } from '@/storage';
import { runLegacyWipeSmoke, wipeLegacyKeysOnce } from '@/storage/legacy-wipe';
import { initChoice, initChoiceMinimal, runChoiceSmoke } from '@/modules/choice';
import { initNav, initNavMinimal } from '@/modules/nav';
import { initApis } from '@/modules/apis';
import { initPersona, initPersonaMinimal, runPersonaSmoke } from '@/modules/persona';
import { version } from '@/version';

/** 存储域 dump 挂入统一排障口（devtools 直取 __TT_TOOLKIT__.storage.dump()）。 */
function installStoragePort(): void {
    toolkitGlobalPort().storage = Object.freeze({ dump: dumpStorage });
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
    registerTab(createNavSettingsTab());
    registerTab(createPersonaTab());
    registerTab(createLogTab());
    initChoice();
    initNav();
    // 统一端点表：persona 域迁移先成型（initApis 内先 migratePersonaDomain），
    // 再收编 choice/persona 旧 API 字段——顺序敏感，勿调换
    initApis();
    initPersona();
    // 遗留 localStorage 键一次性清理——位于全部幂等迁移之后
    // （迁移消费在先、删除在后，绝不碰已迁移数据），见 storage/legacy-wipe
    wipeLegacyKeysOnce();
    console.info(`[tt-toolkit] v${version} ready (rewrite)`);
}

void main();
