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
 * node 冒烟流整链在 src/node-smoke.ts（编排顺序与 boot 收尾标记见该件）。
 *
 * 冒烟面经动态 import 按需加载（批 A 发布件分块）：分支体在浏览器永不
 * 执行，冒烟机判与夹具因此不进浏览器加载面；node 侧加载的仍是同一构建
 * 图的产物，「测的就是发布件」不丢。pinia 激活（import '@/pinia'）保持
 * 静态导入，须先于一切分支。
 * 时序约束：storage 必须先于一切读方初始化（旧 localStorage 键迁移
 * 先于 store 首读），故初始化主权集中在此、不在各模块。
 */

// 先激活 pinia：后续命令式模块在事件回调里取 store 依赖 active 实例
import '@/pinia';
import { mountShell, registerTab } from '@/shell';
import { createApiTab, createChoiceSettingsTab, createLogTab, createPersonaTab } from '@/shell/tabs';
import { initStorage } from '@/storage';
import { wipeLegacyKeysOnce } from '@/storage/legacy-wipe';
import { retireSummaryKeys } from '@/storage/retire-summary';
import { initChoice } from '@/modules/choice';
import { initNav } from '@/modules/nav';
import { initApis } from '@/modules/apis';
import { initPersona } from '@/modules/persona';
import { installPromptsPort, installStoragePort } from '@/ports';
import { version } from '@/version';

async function main(): Promise<void> {
    if (typeof document === 'undefined') {
        // node 冒烟：boot 标识恒 boot1——二次启动由 scripts/smoke.mjs 以
        // 全新子进程实现，两次启动靠进程边界区分（冒烟 chunk 回引入口的
        // 相对路径与入口 query 相斥，query 方案已随分块废弃）。
        const { runNodeSmoke } = await import('./node-smoke');
        await runNodeSmoke('boot1');
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
