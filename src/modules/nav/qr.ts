/**
 * nav 入口接线：TT 原生快速回复（QR）栏 + slash 命令。
 * 命令是主体、QR 集是按钮化包装：QR 扩展不可用时命令通道仍独立
 * 可用，不静默降级。
 */

import {
    hostWindow,
    isSlashCommandRegistered,
    registerSlashCommand,
    showToast as toast,
    waitForResource,
} from '@/host';
import { CHOICE_GEN_COMMAND, TOOLBOX_COMMAND } from '@/constants';
import { getNavState, setNavState } from './storage';
import { NAV_VERSION, ttlog } from './config';
import { navigateAssistantReply, scrollCurrentMessageToTop } from './navigate';

export const QR_SET_NAME = 'tt-toolkit 导航';

/** 导航命令：slash 注册与 QR 建键同表（命令与按钮一一对应，无只注册不建键的特例）。 */
const NAV_ACTIONS = Object.freeze([
    { command: 'ttnav-top', label: '回顶', title: '当前消息回顶：视口顶楼层对齐到顶', run: (): Promise<void> => scrollCurrentMessageToTop() },
    { command: 'ttnav-prev', label: '上一条', title: '跳到上一条角色回复', run: (): Promise<void> => navigateAssistantReply(-1) },
    { command: 'ttnav-next', label: '下一条', title: '跳到下一条角色回复', run: (): Promise<void> => navigateAssistantReply(1) },
] as const);

/**
 * 跨模块键：命令归各功能模块注册（生成＝choice 的 /tt-choice-gen，工具箱
 * ＝shell 的 /tt-toolbox），nav 只建按钮。message 一律由 @/constants 单源
 * 拼出，防双侧硬编码漂移静默断链。
 */
const EXTRA_QR = Object.freeze([
    { command: CHOICE_GEN_COMMAND, label: '生成', title: '生成行动选项（生成中再点＝取消）' },
    { command: TOOLBOX_COMMAND, label: '工具箱', title: '打开 TT 工具箱' },
] as const);

/** QR 集按钮全集：ensure 循环与日志口径都取这张表。 */
const QR_BUTTONS = Object.freeze([...NAV_ACTIONS, ...EXTRA_QR]);

// quickReplyApi 等待轮询参数（QR 扩展 init 同步挂载 api、先于 APP_READY，
// 但扩展加载顺序不受本模块控制，等待期按最坏情况放宽）
const QR_POLL_INTERVAL_MS = 250;
const QR_POLL_MAX_TRIES = 40;

interface QuickReplyLike {
    message?: string;
    title?: string;
}

// quickReplyApi 的方法面（TauriTavern src/scripts/extensions/quick-reply/
// api/QuickReplyApi.js 核实：getSetByName :33 / getQrByLabel :44 /
// createQuickReply :203 / updateQuickReply :263 / addGlobalSet :111 /
// async createSet :383 / deleteQuickReply :307——不存在时抛错，
// 调用前须先 getQrByLabel 确认在场）
interface QuickReplyApiLike {
    getSetByName(name: string): unknown;
    createSet(name: string): Promise<void>;
    getQrByLabel(setName: string, label: string): QuickReplyLike | null | undefined;
    createQuickReply(setName: string, label: string, props: { message: string; title?: string }): Promise<unknown>;
    updateQuickReply(setName: string, label: string, props: { message: string; title?: string }): Promise<unknown>;
    deleteQuickReply(setName: string, label: string): void;
    addGlobalSet(name: string): Promise<unknown>;
}

export function getQuickReplyApi(): QuickReplyApiLike | null {
    const api = hostWindow.quickReplyApi;
    return typeof api === 'object' && api !== null ? (api as QuickReplyApiLike) : null;
}

// 三段等待走 host 单点（立查 → APP_READY 重放复测 → 轮询兜底到 deadline）；
// APP_READY 已发而 api 仍缺席＝QR 扩展被禁用，返回 null 即认定失败
function waitForQuickReplyApi(): Promise<QuickReplyApiLike | null> {
    return waitForResource(getQuickReplyApi, {
        intervalMs: QR_POLL_INTERVAL_MS,
        maxTries: QR_POLL_MAX_TRIES,
    });
}

export function qrActivated(): boolean {
    return getNavState().qrActivated;
}

function markQrActivated(): void {
    setNavState({ qrActivated: true });
}

export async function ensureNavQrSet(): Promise<void> {
    const api = await waitForQuickReplyApi();
    if (!api) {
        // fail fast：QR 栏缺席要让用户看见，且明说替代入口（命令通道独立于 QR）
        console.warn(`[tt-toolkit][nav] ${NAV_VERSION}: quickReplyApi unavailable, QR bar not created; /ttnav-* and /${CHOICE_GEN_COMMAND} commands remain available`);
        ttlog.warn('quickReplyApi unavailable after wait, QR bar skipped');
        toast(`快速回复不可用：命令已注册为 /ttnav-*、/${CHOICE_GEN_COMMAND}，可在输入框直接执行`, 'warning');
        return;
    }

    try {
        // createSet 对同名集是原位替换语义（丢集内全部 QR），仅在集不存在时
        // 调用；已存在只逐条补缺/对齐 message，不触 updateSet/deleteSet
        // （保护用户对集属性与按钮的自定义）
        if (!api.getSetByName(QR_SET_NAME)) {
            await api.createSet(QR_SET_NAME);
        }
        for (const action of QR_BUTTONS) {
            const message = qrMessage(action);
            const existing = api.getQrByLabel(QR_SET_NAME, action.label);
            if (!existing) {
                // 跨模块键建键前先校验命令在场：命令缺席时按钮会静默指向
                // 不存在的命令——fail fast 跳过并留痕，其余键不受影响
                if (!isSlashCommandRegistered(action.command)) {
                    toast(`导航按钮「${action.label}」未建立：/${action.command} 命令不在场`, 'warning');
                    ttlog.warn(`QR button "${action.label}" skipped: /${action.command} not registered`);
                    continue;
                }
                await api.createQuickReply(QR_SET_NAME, action.label, { message, title: action.title });
                continue;
            }
            if (existing.message === message) {
                // 已是本扩展命令：只补缺 title（老版本建的键可能没提示），
                // 不覆盖用户可能改过的任何内容
                if (!existing.title) {
                    await api.updateQuickReply(QR_SET_NAME, action.label, { message, title: action.title });
                }
                continue;
            }
            // 统一 adopt 判据：同名键指向别处＝用户自建，不建不改不接管
            // （入口退化为命令直敲；静默改写用户按钮＝破坏用户自定义）。
            // 撞名与命令缺席同为「按钮没建成」的用户可见事件，提示口径一致
            toast(`导航按钮「${action.label}」未接管：与你的同名自定义键冲突，可输入框直接执行 /${action.command}`, 'warning');
            ttlog.info(`QR button "${action.label}" kept as user-defined (message=${existing.message ?? '(空)'}), not adopted`);
        }

        // 激活一次制：仅首次把集挂入全局列表并置位；用户此后手动移除该集
        // 不复活（尊重用户对快速回复栏的自主管理）
        if (!qrActivated()) {
            await api.addGlobalSet(QR_SET_NAME);
            markQrActivated();
        }
        ttlog.info(`QR set "${QR_SET_NAME}" ready (activated=${qrActivated()}, buttons=${QR_BUTTONS.length} 含生成与工具箱)`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ttlog.error('QR set ensure failed', msg);
        toast(`导航快速回复建立失败[${NAV_VERSION}]：${msg}`, 'error');
    }
}

// QR message＝slash 命令本体，不带尾空格——宿主执行时会自行拼接：
// QuickReplySet.js:160 executeWithOptions 的 else 分支
// `input = `${finalMessage} ` `，自带尾空格成冗余
function qrMessage(action: { command: string }): string {
    return `/${action.command}`;
}

export function registerSlashCommands(): void {
    for (const action of NAV_ACTIONS) {
        // host 层 registerSlashCommand 内建重名 pre-check（addCommandObject
        // 静默覆盖坑，见 host/slash.ts 核实记录）
        const ok = registerSlashCommand({
            name: action.command,
            helpString: action.title,
            callback: async () => {
                // 错误表面化：入口异常必须 toast 给用户，不许只留日志
                try {
                    await action.run();
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    toast(`导航出错[${NAV_VERSION}]：${msg}`, 'error');
                    ttlog.error(`/${action.command} handler error`, msg);
                }
                return '';
            },
        });
        if (ok) ttlog.info(`slash command registered: /${action.command}`);
    }
    ttlog.info(`slash commands registration pass done: ${NAV_ACTIONS.map(a => `/${a.command}`).join(' ')}`);
}
