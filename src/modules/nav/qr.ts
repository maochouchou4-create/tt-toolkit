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
import { TOOLBOX_COMMAND } from '@/constants';
import { getNavState, setNavState } from './storage';
import { NAV_VERSION, ttlog } from './config';
import { toggleAutoTop } from './auto-top';
import { navigateAssistantReply, scrollCurrentMessageToTop } from './navigate';

export const QR_SET_NAME = 'tt-toolkit 导航';
// QR 集末位的「工具箱」按钮（用户拍板的入口形态：比魔棒菜单顺手）。
// message 指向 shell 注册的命令——TOOLBOX_COMMAND 常量在 @/constants
// （单一事实源），防双侧硬编码漂移静默断链。
const TOOLBOX_QR = Object.freeze({
    label: '工具箱',
    title: '打开 TT 工具箱',
    message: `/${TOOLBOX_COMMAND}`,
});
// quickReplyApi 等待轮询参数（QR 扩展 init 同步挂载 api、先于 APP_READY，
// 但扩展加载顺序不受本模块控制，等待期按最坏情况放宽）
const QR_POLL_INTERVAL_MS = 250;
const QR_POLL_MAX_TRIES = 40;

// 命令表＝slash 注册与 QR 按钮的单一事实源；qr=false 的项只注册命令、
// 不建 QR 按钮（自动回顶在设置页有开关，QR 面上属重复入口——用户拍板）
const NAV_ACTIONS = Object.freeze([
    { command: 'ttnav-top', label: '回顶', title: '当前消息回顶：视口顶楼层对齐到顶', qr: true, run: (): Promise<void> => scrollCurrentMessageToTop() },
    { command: 'ttnav-prev', label: '上一条', title: '跳到上一条角色回复', qr: true, run: (): Promise<void> => navigateAssistantReply(-1) },
    { command: 'ttnav-next', label: '下一条', title: '跳到下一条角色回复', qr: true, run: (): Promise<void> => navigateAssistantReply(1) },
    { command: 'ttnav-auto', label: '自动回顶', title: '自动回顶开关：生成结束后跳回最新楼层', qr: false, run: (): Promise<void> => toggleAutoTop() },
] as const);

// QR 面上的导航键数（qr=true 项），日志口径＝此数＋工具箱键
const QR_NAV_COUNT = NAV_ACTIONS.filter(a => a.qr).length;

interface QuickReplyLike {
    message?: string;
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
    updateQuickReply(setName: string, label: string, props: { message: string }): Promise<unknown>;
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
        console.warn(`[tt-toolkit][nav] ${NAV_VERSION}: quickReplyApi unavailable, QR bar not created; /ttnav-* commands remain available`);
        ttlog.warn('quickReplyApi unavailable after wait, QR bar skipped');
        toast('快速回复不可用：命令已注册为 /ttnav-*，可在输入框直接执行', 'warning');
        return;
    }

    try {
        // createSet 对同名集是原位替换语义（丢集内全部 QR），仅在集不存在时
        // 调用；已存在只逐条补缺/对齐 message，不触 updateSet/deleteSet
        // （保护用户对集属性与按钮的自定义）
        if (!api.getSetByName(QR_SET_NAME)) {
            await api.createSet(QR_SET_NAME);
        }
        // 历史版本建过的「自动回顶」QR 键清理（本版起该入口只留命令与设置页
        // 开关）：一次性标记短路（legacyQrCleaned），不做每启动探测——
        // deleteQuickReply 对缺席键抛错，先探测后删
        if (!getNavState().legacyQrCleaned) {
            const legacyQrOnly = NAV_ACTIONS.find(a => !a.qr);
            if (legacyQrOnly && api.getQrByLabel(QR_SET_NAME, legacyQrOnly.label)) {
                api.deleteQuickReply(QR_SET_NAME, legacyQrOnly.label);
                ttlog.info(`legacy QR "${legacyQrOnly.label}" removed`);
            }
            setNavState({ legacyQrCleaned: true });
        }
        for (const action of NAV_ACTIONS) {
            if (!action.qr) continue;
            const qr = api.getQrByLabel(QR_SET_NAME, action.label);
            if (!qr) {
                await api.createQuickReply(QR_SET_NAME, action.label, {
                    message: qrMessage(action),
                    title: action.title,
                });
            } else if (qr.message !== qrMessage(action)) {
                await api.updateQuickReply(QR_SET_NAME, action.label, {
                    message: qrMessage(action),
                });
            }
        }

        // 工具箱按钮＝集末位第四键（3 导航键＋工具箱），补缺/对齐纪律与导航
        // 键一致（已存在只对齐 message，保护用户自定义）。建键前先校验命令
        // 在场：壳侧注册被占（重名）时按钮会静默指向别人的命令——
        // fail fast，跳过建键并留痕，导航键不受影响
        if (!isSlashCommandRegistered(TOOLBOX_COMMAND)) {
            toast(`工具箱入口未建立：/${TOOLBOX_COMMAND} 命令不在场`, 'warning');
            ttlog.warn(`toolbox QR skipped: /${TOOLBOX_COMMAND} not registered`);
        } else {
            const qr = api.getQrByLabel(QR_SET_NAME, TOOLBOX_QR.label);
            if (!qr) {
                await api.createQuickReply(QR_SET_NAME, TOOLBOX_QR.label, {
                    message: TOOLBOX_QR.message,
                    title: TOOLBOX_QR.title,
                });
            } else if (qr.message !== TOOLBOX_QR.message) {
                await api.updateQuickReply(QR_SET_NAME, TOOLBOX_QR.label, {
                    message: TOOLBOX_QR.message,
                });
            }
        }

        // 激活一次制：仅首次把集挂入全局列表并置位；用户此后手动移除该集
        // 不复活（尊重用户对快速回复栏的自主管理）
        if (!qrActivated()) {
            await api.addGlobalSet(QR_SET_NAME);
            markQrActivated();
        }
        ttlog.info(`QR set "${QR_SET_NAME}" ready (activated=${qrActivated()}, buttons=${QR_NAV_COUNT + 1} 含工具箱)`);
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

