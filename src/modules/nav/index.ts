/**
 * 消息回顶/上下文导航（逻辑平移，纯 TS 无 UI）。
 *
 * 平移自旧仓 nav 模块 v2（rewrite 前旧结构，已随旧结构删除）：
 * 楼层定位主线/兜底、落点校验循环、自动回顶状态机、CONFIG 常量原样照搬。
 * 平移层的接线差异：
 *   - @sillytavern 导入（events/SlashCommand）改走本仓 host 适配层
 *     （host 层已做重名注册 pre-check 与类型收敛）；
 *   - 楼层数据取 getContext().chat 全量数组（绝对索引即楼层号）；角色
 *     判定按 ChatPayload 契约：role 不总存在，缺失时回退 legacy 布尔
 *     （只判 role==='assistant' 在普通聊天匹配 0 条——批3 回归根因）；
 *   - 斜杠执行器走宿主 executeSlashCommandsWithOptions，缺席时脚本内
 *     滚动作兜底；
 *   - qrActivated 持久化改走统一存储（storage.service 启动时迁移旧
 *     localStorage 键；遗留键 v1.0.0 起由 storage/legacy-wipe 首启一次性
 *     清理）；
 *   - 日志转发走 host/ttlog（createTtlog 工厂），target 仍为 "msgnav"，
 *     落盘 tauritavern.log.*；
 *   - 入口仍为 TT 原生快速回复栏：「tt-toolkit 导航」按钮集（三导航键
 *     ＋末位「工具箱」键，消息体为 /ttnav-* 与 /tt-toolbox 斜令），
 *     命令亦可直接在输入框敲。自动回顶恒开，无开关命令与设置项。
 * - 初始化为显式导出（initNav / initNavMinimal），由 main.ts 统一做
 *   环境分支后调用——模块求值期不自启动：storage 必须先初始化（旧
 *   localStorage 键迁移），否则 store 首读会拿到迁移前的旧值。
 * DOM 契约与 v2 同源已核：#chat / .mes[mesid]（TT index.html:8382 区域）、
 * #mes_stop（:8417）、#send_but（:8422）。
 *
 * 分区文件：config（常量/日志）、dom（定位/楼层数据）、scroll（楼层
 * 定位核心）、navigate（手动导航）、auto-top（自动回顶状态机）、
 * qr（QR 接线＋斜令注册）；本文件只留事件接线、dump 排障口与初始化。
 */

import { eventBus, event_types, safeText } from '@/host';
import { toolkitGlobalPort } from '@/global-port';
import { CONFIG, NAV_VERSION, ttlog, ttlogHealth } from './config';
import { getLastMessageIdSafe, getScrollRoot } from './dom';
import { jumpExecutorAvailable, lastJumpModeUsed } from './scroll';
import { bumpSettle, clearPendingAutoTop, isGenerationActive, startGenerationWatch } from './auto-top';
import { ensureNavQrSet, getQuickReplyApi, qrActivated, QR_SET_NAME, registerSlashCommands } from './qr';
import { clearNavReference } from './navigate';

// 防异常双注入：同 URL 的动态 import 不会重复执行，但扩展重载/缓存击穿
// 场景下 ESM 层无保护，仍需窗口旗标。字面量只出现一次（机判断言），
// 经由常量间接引用。
const NAV_FLAG = '__TT_NAV_MOD__';

// --------------------------------------------------------
// 事件接线
// --------------------------------------------------------
function bindEvents(): void {
    // 渲染活动顺延静默窗口（MVU 改写正文、楼层重渲染）
    eventBus.on(event_types.MESSAGE_UPDATED, bumpSettle);
    eventBus.on(event_types.CHARACTER_MESSAGE_RENDERED, bumpSettle);

    // 切换聊天时丢弃未完成的自动回顶与楼层记忆点（新聊天楼号重排）
    eventBus.on(event_types.CHAT_CHANGED, () => {
        clearPendingAutoTop();
        clearNavReference();
        ttlog.info('chat changed, pending auto-top dropped, nav ref cleared');
    });
}

// --------------------------------------------------------
// dump 排障口：无 UI 排障口，主窗口 devtools 直取
// __TT_TOOLKIT__.nav.dump()；node 冒烟（无 DOM）下输出降级视图
// （root/genActive 标 n/a），不抛错
// --------------------------------------------------------
function dump(): string {
    const noDom = typeof document === 'undefined';
    const root = noDom ? null : getScrollRoot();
    const lines = [
        `tt-toolkit nav dump @ ${new Date().toISOString()}`,
        `version=${NAV_VERSION} ttlog=${ttlogHealth()} mode=${lastJumpModeUsed() ?? 'none'} jumpExecutor=${jumpExecutorAvailable() ? 'present' : 'absent'}`,
        `qrApi=${getQuickReplyApi() ? 'ready' : 'unavailable'} qrSet="${QR_SET_NAME}" qrActivated=${qrActivated()}`,
        `root=${root ? `#${root.id || '(no id)'}` : noDom ? 'n/a (no DOM)' : 'missing'}`
            + ` mounted=${root ? root.querySelectorAll(CONFIG.SEL.MESSAGE).length : 0}`
            + ` lastId=${getLastMessageIdSafe()} genActive=${noDom ? 'n/a' : isGenerationActive()}`,
        '--- ring (oldest first) ---',
        ...ttlog.getBuffer().map(e => `${e.timestamp} [${e.type}] ${e.message}${e.data !== null && e.data !== undefined ? ` | ${safeText(e.data)}` : ''}`),
    ];
    return lines.join('\n');
}

// --------------------------------------------------------
// 初始化 —— 显式导出，由 main.ts 统一做环境分支（加载完成不加
// toast：console 的模块 ready 日志即载体）。
// 浏览器流调 initNav()（全量），node 冒烟流调 initNavMinimal()
// （无 DOM 最小集）。模块求值期不自启动，时序主权在引导层。
// --------------------------------------------------------

/** 浏览器全量初始化：命令注册 + QR 集建立 + 事件接线 + 生成监听。 */
export function initNav(): void {
    const start = (): void => {
        registerSlashCommands();
        void ensureNavQrSet(); // 异步等 QR API 就绪，不阻塞命令注册与事件接线
        bindEvents();
        startGenerationWatch();
        ttlog.info(`${NAV_VERSION} loaded mode=${lastJumpModeUsed() ?? 'none'} jumpExecutor=${jumpExecutorAvailable() ? 'present' : 'absent'} ttlog=${ttlogHealth()}`);
    };
    // 防御性等待：扩展脚本正常晚于 DOM 就绪，但 readyState 仍为 loading
    // 时（宿主加载流程变更）不应在半初始化的 DOM 上接线
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => start());
        return;
    }
    start();
}

/** node 冒烟最小初始化：只做不依赖 DOM/QR 的命令注册与事件绑定。 */
export function initNavMinimal(): void {
    registerSlashCommands();
    bindEvents();
    ttlog.info(`${NAV_VERSION} minimal init (node smoke) ttlog=${ttlogHealth()}`);
}

const flagWindow = globalThis as Record<string, unknown>;

if (flagWindow[NAV_FLAG]) {
    console.warn('[tt-toolkit][nav] already loaded, skip re-injection');
} else {
    flagWindow[NAV_FLAG] = true;
    // 排障口先挂（不依赖 DOM、不触发初始化）：node 冒烟路径也要能用
    // dump 验证模块在场
    toolkitGlobalPort().nav = Object.freeze({ version: NAV_VERSION, dump });
}
