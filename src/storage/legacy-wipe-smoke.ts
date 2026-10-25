/**
 * legacy-wipe 一次性清理的烟雾机判（批 A 自 legacy-wipe.ts 拆出，纯搬移；
 * node 冒烟里紧随启动管线收口；persona smoke 会中途回收旧键并重置
 * persona 域，本机判必须在 runPersonaSmoke 之前跑）。
 * 判别式：迁移数据「未受损」用与缺省值相反的种子态证明——
 *   userContext.request 缺省 ''（种子非空只能来自 smoke.mjs 预种＋boot
 *   迁移搬运）；localConfig 已随任务参数固化退役（种子 stream=false/
 *   timeoutSec=600 经域 normalize 丢弃——断言域内无该键）；nav.qrActivated
 *   缺省 false（种子激活态 true）。跨文件不共享标记字面量。
 *
 * 独立成件不经 storage 桶导出：桶在入口静态图上，smoke 名经桶即把本件
 * 拉回浏览器加载面（消费方 src/node-smoke.ts 直取）。
 */
// 两个模块 import 只服务机判段（跨段排序证明：迁移先于清理），
// 生产清理路径不碰它们——断言语义看的是各域 normalize 后的视图（persona 那条
// 正是靠 normalize 的丢弃面证明退役键已退场），改读裸域值即改断言。
import { readPersonaDomain } from '@/modules/persona/storage';
import { getNavState } from '@/modules/nav/storage';
import { getGlobal, LEGACY_NAV_AUTO_TOP_KEY, LEGACY_NAV_QR_ACTIVATED_KEY, setGlobal } from './service';
import {
    LEGACY_PERSONA_DATA_USER_KEY,
    LEGACY_PERSONA_STATE_KEY,
    LEGACY_PERSONA_UI_STATE_KEY,
    LEGACY_WIPE_FLAG_KEY,
    LEGACY_WIPE_KEYS,
    wipeLegacyKeysOnce,
} from './legacy-wipe';

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
    seedKey(LEGACY_PERSONA_STATE_KEY, JSON.stringify({ localConfig: { stream: false, timeoutSec: 600 } }));
    seedKey(LEGACY_PERSONA_UI_STATE_KEY, JSON.stringify({ generationPreset: 'pure' }));
    seedKey(LEGACY_PERSONA_DATA_USER_KEY, JSON.stringify({ request: 'wipe-smoke 场景种子', result: '' }));
}

export function runLegacyWipeSmoke(): void {
    console.info('=== legacy-wipe 一次性清理机判 ===');
    const total = LEGACY_WIPE_KEYS.length;
    const presentAtEntry = LEGACY_WIPE_KEYS.filter(keyPresent);
    const flagAtEntry = getGlobal(LEGACY_WIPE_FLAG_KEY) === true;

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
            'boot：persona 域 localConfig 键退役丢弃（任务参数固化，normalize 新形状清洗）',
            !('localConfig' in (persona as unknown as Record<string, unknown>)),
        );
        check('boot：nav 域迁移数据未受损（种子 qrActivated 激活态存活）', getNavState().qrActivated === true);
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
    check('场景A：标记置位', getGlobal(LEGACY_WIPE_FLAG_KEY) === true);
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
