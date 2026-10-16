/**
 * choice 模块入口：聊天选项条挂载。
 *
 * 选项条停靠：#send_form 之前（输入框上方、不随聊天滚动——#form_sheld
 * 是静态骨架 DOM，宿主先于扩展脚本在场；仍保留轮询兜底防宿主加载流程
 * 变更）。每次组装前现取宿主数据（不缓存）。
 *
 * 排障口不在本模块安装：__TT_TOOLKIT__.prompts 的 dump 按任务键分派，
 * 任务键全集跨模块（persona 两任务由 persona 模块实现），分派权归同时
 * 持有两侧的引导层（见 src/main.ts）。本模块只出自己那侧的探针。
 */
import { createApp } from 'vue';
import { pinia } from '@/pinia';
import { eventBus, event_types, waitForResource } from '@/host';
import { ensurePromptConfigs } from '@/prompts';
import { version } from '@/version';
import { installAutoGenerate } from './auto';
import { latestAssistantFloorIndex } from './persist';
import { syncAssetPool } from './pool/asset';
import { useChoiceStore } from './store';
import OptionsBar from './OptionsBar.vue';

const BAR_MOUNT_ID = 'tt-choice-bar-mount';
const POLL_INTERVAL_MS = 500;
const POLL_MAX_TRIES = 20;

let barMounted = false;

/**
 * 楼层同步（选项条语义＝「当前楼层的选项」）：四事件统一重载末楼——
 * CHAT_CHANGED 切聊天 / MESSAGE_SWIPED 换 swipe 槽（宿主 swipe 只 emit
 * 它，必订）/ MESSAGE_UPDATED 编辑器保存修订 / MESSAGE_DELETED 删楼
 * （索引左移后重载）。订阅形态照 persona 的幂等安装（扩展生命周期与
 * 页面同寿，监听常驻不退订）。
 */
let floorSyncInstalled = false;

function installFloorSync(): void {
    if (floorSyncInstalled) return;
    floorSyncInstalled = true;
    const sync = () => useChoiceStore().syncToFloor(latestAssistantFloorIndex());
    eventBus.on(event_types.CHAT_CHANGED, sync);
    eventBus.on(event_types.MESSAGE_SWIPED, sync);
    eventBus.on(event_types.MESSAGE_UPDATED, sync);
    eventBus.on(event_types.MESSAGE_DELETED, sync);
}

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
 * choice 模块初始化（浏览器路径，main.ts 引导调用）。
 * node 冒烟路径走 initChoiceMinimal（无 DOM）。
 */
export function initChoice(): void {
    ensurePromptConfigs();
    syncAssetPool();
    installAutoGenerate();
    installFloorSync();
    // 启动即按当前末楼装载（聊天晚于扩展就绪时由四事件补齐）
    useChoiceStore().syncToFloor(latestAssistantFloorIndex());
    void mountBarWithRetry();
    console.info(`[tt-toolkit][choice] 选项生成核心已初始化 v${version}（组装管线与选项条）`);
}

/** node 冒烟最小初始化：默认配置落盘＋asset 池同步＋自动生成守卫，不挂 DOM。 */
export function initChoiceMinimal(): void {
    ensurePromptConfigs();
    syncAssetPool();
    installAutoGenerate();
    installFloorSync();
}

/** 组装结果原始形态（排障口 assemble 探针的实现在此，choice 任务专用）。 */
export { assembleCurrent } from './generator';
export { parseOptions, DEBUG_MALFORMED_RAW } from './parse';
export { useChoiceSettingsStore } from './settings';
export { useStoryDirectionStore, type DirectionPreset } from './direction';
export { DEFAULT_GEN_PARAMS, type ChoiceGenParams } from './api';
