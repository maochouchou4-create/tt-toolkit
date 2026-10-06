/**
 * 旧 localStorage 遗留键一次性清理（批E／v1.0.0）。
 *
 * 背景：rewrite 前旧结构把 persona（5 键）与 nav（2 键）状态存
 * localStorage；新结构由幂等迁移搬进 extension_settings.ttToolkit
 * 全局域后，旧键一直保留只读作回滚保险。v1.0.0 收官由本模块一次性
 * 删除，防键名随年代漂移、也断掉「回滚旧版再升回」的增量采纳分支。
 *
 * 顺序硬约束（main.ts 接线保证）：本清理位于启动管线末位——先跑完
 * 全部既有幂等迁移（initStorage 的 nav 增量迁移、initApis 的 persona
 * 域迁移＋统一端点收编），迁移消费在先、删除在后；清理只删
 * localStorage 遗留键，绝不碰已迁移数据与 settings.json 里旧扩展自身
 * 的 settings 域。
 *
 * 幂等标记：全局域 legacyWipeDone（缺省视为 false）。置 true 后整段
 * 跳过＝二次启动 no-op。
 */

import { LEGACY_KEYS, readPersonaDomain } from '@/modules/persona/storage';
import { getGlobal, getNavState, LEGACY_NAV_AUTO_TOP_KEY, LEGACY_NAV_QR_ACTIVATED_KEY, setGlobal } from './service';

/**
 * 清理键清单：单一真相源＝迁移代码的常量表（persona LEGACY_KEYS＋nav
 * 两个迁移源键，service.ts 导出），此处仅聚合，禁另写字面量。
 * persona 侧自世界书勾选/钉选域退役起为 3 键（pw_wi_selection_v1/
 * pw_pinned_books_v1 已随 v1.0.0 一次性清理离场，无键可管）。
 */
export const LEGACY_WIPE_KEYS: readonly string[] = [
    ...Object.values(LEGACY_KEYS),
    LEGACY_NAV_AUTO_TOP_KEY,
    LEGACY_NAV_QR_ACTIVATED_KEY,
];

/** 全局域一次性标记字段名（GlobalDomain.legacyWipeDone）。 */
export const LEGACY_WIPE_FLAG_KEY = 'legacyWipeDone';

export interface LegacyWipeReport {
    /** true＝标记在场，整段跳过（本次未删任何键）。 */
    skipped: boolean;
    /** 实际删除的键（在场才计）。 */
    wipedKeys: string[];
}

function removeKeyIfPresent(key: string): boolean {
    const ls = globalThis.localStorage;
    if (ls === undefined || ls === null) return false;
    try {
        if (ls.getItem(key) === null) return false;
        ls.removeItem(key);
        return true;
    } catch {
        // localStorage 不可用（隐私模式等）＝无存量可清
    }
    return false;
}

/**
 * 一次性清理（启动管线末位调用）：
 *   1. legacyWipeDone === true → 整段跳过；
 *   2. 删除全部遗留键（在场才计）；
 *   3. 置 legacyWipeDone = true（setGlobal → writeExtensionSettings →
 *      saveSettingsDebounced 持久化）。
 */
export function wipeLegacyKeysOnce(): LegacyWipeReport {
    if (getGlobal<boolean>(LEGACY_WIPE_FLAG_KEY) === true) {
        console.info('[legacy-wipe] 标记在场，跳过（一次性清理已执行过）');
        return { skipped: true, wipedKeys: [] };
    }
    const wipedKeys = LEGACY_WIPE_KEYS.filter(removeKeyIfPresent);
    setGlobal(LEGACY_WIPE_FLAG_KEY, true);
    console.info(
        `[legacy-wipe] 遗留键一次性清理：删除 ${wipedKeys.length}/${LEGACY_WIPE_KEYS.length} 键` +
            `（${wipedKeys.join('、') || '无在场'}），标记已置位`,
    );
    return { skipped: false, wipedKeys };
}

// ---------------------------------------------------------------------------
// 烟雾机判（node 冒烟里紧随启动管线收口；persona smoke 会中途回收旧键并
// 重置 persona 域，本机判必须在 runPersonaSmoke 之前跑）。
// 判别式：迁移数据「未受损」用与缺省值相反的种子态证明——
//   userContext.request 缺省 ''（种子非空只能来自 smoke.mjs 预种＋boot
//   迁移搬运）；localConfig 缺省 stream=true/timeoutSec=300（种子
//   stream=false/timeoutSec=600）；nav.autoTop 缺省 true（种子关态
//   false）。跨文件不共享标记字面量。
// ---------------------------------------------------------------------------

const wipeFailures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
    console.info(`[wipe-smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) wipeFailures.push(label);
}

function keyPresent(key: string): boolean {
    const ls = globalThis.localStorage;
    if (ls === undefined || ls === null) return false;
    try {
        return ls.getItem(key) !== null;
    } catch {
        return false;
    }
}

function seedKey(key: string, value: string): void {
    try {
        globalThis.localStorage?.setItem(key, value);
    } catch {
        // 存根缺席＝种不进，后续断言自然红
    }
}

function removeSeed(key: string): void {
    try {
        globalThis.localStorage?.removeItem(key);
    } catch {
        // 同上
    }
}

/** 场景种子（形状对齐各键迁移解析面；值仅作在场证据，不参与断言）。 */
function seedAll(): void {
    seedKey(LEGACY_NAV_AUTO_TOP_KEY, '0');
    seedKey(LEGACY_NAV_QR_ACTIVATED_KEY, '1');
    seedKey(LEGACY_KEYS.state, JSON.stringify({ localConfig: { stream: false, timeoutSec: 600 } }));
    seedKey(LEGACY_KEYS.uiState, JSON.stringify({ generationPreset: 'pure' }));
    seedKey(LEGACY_KEYS.dataUser, JSON.stringify({ request: 'wipe-smoke 场景种子', result: '' }));
}

export function runLegacyWipeSmoke(): void {
    console.info('=== legacy-wipe 一次性清理机判（批E）===');
    const total = LEGACY_WIPE_KEYS.length;
    const presentAtEntry = LEGACY_WIPE_KEYS.filter(keyPresent);
    const flagAtEntry = getGlobal<boolean>(LEGACY_WIPE_FLAG_KEY) === true;

    if (presentAtEntry.length === 0) {
        // 一次启动签名：boot（迁移→清理）已跑完——键全删＋标记置位＋
        // smoke.mjs 预种的迁移数据存活＝迁移先于清理的完整链路证明
        check('boot：全部遗留键已删除', LEGACY_WIPE_KEYS.every(k => !keyPresent(k)));
        check('boot：一次性标记已置位', flagAtEntry);
        const persona = readPersonaDomain();
        check(
            'boot：persona 域迁移数据未受损（种子 userContext 存活＝迁移先于清理）',
            persona.userContext.request !== '',
        );
        check(
            'boot：persona 域迁移数据未受损（种子 localConfig 存活，异于缺省 stream/timeout）',
            persona.localConfig.stream === false && persona.localConfig.timeoutSec === 600,
        );
        check('boot：nav 域迁移数据未受损（种子关态存活）', getNavState().autoTop === false);
    } else {
        // 二次启动签名：标记在场 → boot 清理整段跳过 → 预重种的键须原样存活
        check(
            'boot2：标记在场时 boot 清理跳过（重种的键全部存活）',
            flagAtEntry && presentAtEntry.length === total,
            `在场 ${presentAtEntry.length}/${total}、标记 ${String(flagAtEntry)}`,
        );
    }

    // 场景 A：重置标记＋重种 → 清理 → 删全部键＋置标＋已迁移域逐字节不变
    setGlobal(LEGACY_WIPE_FLAG_KEY, false);
    seedAll();
    const personaBefore = JSON.stringify(readPersonaDomain());
    const navBefore = JSON.stringify(getNavState());
    const reportA = wipeLegacyKeysOnce();
    check(
        `场景A：重置后清理删除全部 ${total} 键`,
        !reportA.skipped && reportA.wipedKeys.length === total && LEGACY_WIPE_KEYS.every(k => !keyPresent(k)),
    );
    check('场景A：标记置位', getGlobal<boolean>(LEGACY_WIPE_FLAG_KEY) === true);
    check('场景A：persona 域逐字节不变（清理不碰已迁移数据）', JSON.stringify(readPersonaDomain()) === personaBefore);
    check('场景A：nav 域逐字节不变', JSON.stringify(getNavState()) === navBefore);

    // 场景 B：标记在场 → 再清理 → 短路（键存活、报告 skipped）
    seedAll();
    const reportB = wipeLegacyKeysOnce();
    check('场景B：标记在场清理短路（重种键存活）', reportB.skipped && LEGACY_WIPE_KEYS.every(keyPresent));

    // 收尾：清场景种子，标记留 true（与真实首启后终态一致）
    for (const k of LEGACY_WIPE_KEYS) removeSeed(k);

    if (wipeFailures.length > 0) {
        console.error(`[wipe-smoke] FAIL：${wipeFailures.length} 项未过：${wipeFailures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info(
        `[wipe-smoke] OK：一次性清理链路（boot 键删＋标记置位＋迁移数据存活证明 / 域零触碰 / 标记短路 no-op）全部通过`,
    );
}
