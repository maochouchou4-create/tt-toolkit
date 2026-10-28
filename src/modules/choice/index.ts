/**
 * choice 模块入口：楼层选项块安装＋生成入口（导航「生成」键/斜令）接线。
 *
 * 展示面全在 floor-view（纯 DOM，每条 AI 楼层 .mes_block 尾部画自己的
 * 选项块）；输入区不留本扩展任何常驻件。生成入口＝「tt-toolkit 导航」
 * 快速回复集的「生成」键，message 指向本模块注册的 /tt-choice-gen——
 * 命令是主体、QR 是按钮化包装（QR 不可用时命令仍可直敲）。
 *
 * 排障口不在本模块安装：__TT_TOOLKIT__.prompts 的 dump 按任务键分派，
 * 任务键全集跨模块（persona 两任务由 persona 模块实现），分派权归同时
 * 持有两侧的引导层（见 src/main.ts）。本模块只出自己那侧的探针。
 */
import { registerSlashCommand } from '@/host';
import { CHOICE_GEN_COMMAND } from '@/constants';
import { version } from '@/version';
import { installAutoGenerate } from './auto';
import { installFloorView } from './floor-view';
import { toggleChoiceGeneration } from './generator';
import { syncAssetPool } from './pool/asset';

/**
 * 注册 /tt-choice-gen（幂等由 host 层重名 pre-check 保证）。
 * 命令与 QR 按钮共用 CHOICE_GEN_COMMAND 单源；toggle 语义＝生成中再执行
 * 即取消（长请求逃生）。
 */
export function registerChoiceSlashCommand(): void {
    const ok = registerSlashCommand({
        name: CHOICE_GEN_COMMAND,
        helpString: '生成行动选项（生成中执行＝取消）',
        callback: async () => {
            toggleChoiceGeneration();
            return '';
        },
    });
    if (ok) console.info(`[tt-toolkit][choice] 斜杠命令已注册：/${CHOICE_GEN_COMMAND}`);
}

/**
 * choice 模块初始化（浏览器路径，main.ts 引导调用）。
 * node 冒烟路径走 initChoiceMinimal（无 DOM）。
 */
export function initChoice(): void {
    syncAssetPool();
    installAutoGenerate();
    registerChoiceSlashCommand();
    installFloorView();
    console.info(`[tt-toolkit][choice] 选项楼层化已初始化 v${version}（楼层渲染器＋生成命令）`);
}

/** node 冒烟最小初始化：asset 池同步＋自动生成守卫＋命令注册，不碰 DOM。 */
export function initChoiceMinimal(): void {
    syncAssetPool();
    installAutoGenerate();
    registerChoiceSlashCommand();
}

/** 组装结果原始形态（排障口 assemble 探针的实现在此，choice 任务专用）。 */
export { assembleCurrent } from './generator';
export { parseOptions, DEBUG_MALFORMED_RAW } from './parse';
export { useChoiceSettingsStore } from './settings';
export { useStoryDirectionStore, type DirectionPreset } from './direction';
export { DEFAULT_GEN_PARAMS, type ChoiceGenParams } from './api';
export { OVERSAMPLE_LIMITS, estimateInjectionLines } from './pool/resolver';
