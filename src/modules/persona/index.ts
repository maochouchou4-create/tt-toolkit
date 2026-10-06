/**
 * PersonaWeaver fork 入口（批D 平移）。
 *
 * 入口只走工具箱 tab（/tt-toolbox 进壳），不挂 .persona_controls_buttons_block
 * 旧按钮、不新增 DOM 锚点（已拍板）。initPersona 负责 localStorage 旧键
 * 幂等迁移＋store 初始化；node 冒烟路径走 initPersonaMinimal（无 DOM）。
 *
 * MODIFICATIONS（相对上游 PersonaWeaver fork）：
 * - callPopup 弹窗改 shell 内「人设」tab（PersonaTab.vue）。
 * - 独立 API 砍 Anthropic 原生协议，只保留 OpenAI 兼容纯 fetch 形态。
 * - 旧 localStorage 5 键迁移进 extension_settings.ttToolkit.persona 全局域。
 * - 1.2s 防抖热存改显式保存点（见 store.ts 头注）。
 */
import { usePersonaStore } from './store';
import { migratePersonaDomain } from './storage';
import { createTtlog } from '@/host/ttlog';

const log = createTtlog('modules/persona/index');

/**
 * persona 模块初始化（浏览器路径，main.ts 引导调用）。
 * 幂等：域在场零重写；重复启动只做内存态装载。
 */
export function initPersona(): void {
    const report = migratePersonaDomain();
    if (!report.skipped) {
        log.info(`persona 域迁移完成：搬入 ${report.migratedKeys.join('、') || '（无）'}；退休键清理 ${report.retiredKeysCleaned.join('、') || '（无）'}`);
    }
    usePersonaStore().init();
}

/** node 冒烟最小初始化：迁移机判＋store 初始化（存根数据），不挂 DOM。 */
export function initPersonaMinimal(): void {
    initPersona();
}

export { runPersonaSmoke } from './smoke';
export { dumpPersonaTask } from './generation';
