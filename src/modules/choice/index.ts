/**
 * choice 模块入口：聊天选项条挂载＋全局口（__TTK_PROMPTS__ dump）。
 *
 * 选项条停靠：#send_form 之前（输入框上方、不随聊天滚动——#form_sheld
 * 是静态骨架 DOM，宿主先于扩展脚本在场；仍保留轮询兜底防宿主加载流程
 * 变更）。每次组装前现取宿主数据（不缓存）。
 */
import { createApp } from 'vue';
import { pinia } from '@/pinia';
import { waitForResource } from '@/host';
import { ensurePromptConfigs, TASK_KEYS, type TaskKey } from '@/prompts';
import { dumpPersonaTask } from '@/modules/persona';
import { version } from '@/version';
import { installAutoGenerate } from './auto';
import { assembleCurrent } from './generator';
import { parseOptions, DEBUG_MALFORMED_RAW } from './parse';
import { syncAssetPool } from './pool/asset';
import OptionsBar from './OptionsBar.vue';

const BAR_MOUNT_ID = 'tt-choice-bar-mount';
const POLL_INTERVAL_MS = 500;
const POLL_MAX_TRIES = 20;

let barMounted = false;

function tryMountBar(): boolean {
    if (barMounted) return true;
    const form = document.querySelector('#send_form');
    if (!form?.parentElement) return false;
    const container = document.createElement('div');
    container.id = BAR_MOUNT_ID;
    form.parentElement.insertBefore(container, form);
    const app = createApp(OptionsBar);
    app.use(pinia);
    app.mount(container);
    barMounted = true;
    return true;
}

/**
 * 选项条挂载三段等待（host 单点：立查 → APP_READY 重放复测 → 轮询兜底）。
 * tryMountBar 幂等可重入（barMounted 旗标守门）；超时＝宿主骨架缺席，
 * 留痕供排障（fail fast 不静默）。
 */
async function mountBarWithRetry(): Promise<void> {
    const mounted = await waitForResource(() => (tryMountBar() ? true : null), {
        intervalMs: POLL_INTERVAL_MS,
        maxTries: POLL_MAX_TRIES,
    });
    if (!mounted) {
        console.warn(`[tt-toolkit][choice] #send_form 等待超时（${version}），聊天选项条未挂载`);
    }
}

/**
 * 全局口 __TTK_PROMPTS__：dump / assemble / parseOptions。
 * 用户浏览器验收与排障共用（与编辑器 tab 的 dump 展示同一条组装路径）。
 * 整合轮II 起 dump 支持按任务（默认 choice；参数串或 {task} 对象均可）。
 */
function installGlobalPort(): void {
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
    (globalThis as Record<string, unknown>).__TTK_PROMPTS__ = port;
}

/**
 * choice 模块初始化（浏览器路径，main.ts 引导调用）。
 * node 冒烟路径走 initChoiceMinimal（无 DOM）。
 */
export function initChoice(): void {
    ensurePromptConfigs();
    syncAssetPool();
    installGlobalPort();
    installAutoGenerate();
    void mountBarWithRetry();
    console.info(`[tt-toolkit][choice] 选项生成核心已初始化 v${version}（全局口 __TTK_PROMPTS__）`);
}

/** node 冒烟最小初始化：默认配置落盘＋asset 池同步＋全局口在场（dump 走存根数据机判），不挂 DOM。 */
export function initChoiceMinimal(): void {
    ensurePromptConfigs();
    syncAssetPool();
    installGlobalPort();
    installAutoGenerate();
}

export { runChoiceSmoke } from './smoke';
