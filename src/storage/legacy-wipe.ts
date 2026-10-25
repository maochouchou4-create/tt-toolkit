/**
 * 旧 localStorage 遗留键一次性清理（v1.0.0 起）。
 *
 * 背景：rewrite 前旧结构把 persona（5 键）与 nav（2 键）状态存
 * localStorage；新结构由幂等迁移搬进 extension_settings.ttToolkit
 * 全局域后，旧键一直保留只读作回滚保险。v1.0.0 收官由本模块一次性
 * 删除，防键名随年代漂移、也断掉「回滚旧版再升回」的增量采纳分支。
 *
 * 顺序硬约束（main.ts 接线保证）：本清理位于启动管线末位——先跑完
 * 全部既有幂等迁移（initStorage 的 nav 迁移、initApis 的 persona
 * 域迁移＋统一端点收编），迁移消费在先、删除在后；清理只删
 * localStorage 遗留键，绝不碰已迁移数据与 settings.json 里旧扩展自身
 * 的 settings 域。
 *
 * 幂等标记：全局域 legacyWipeDone（缺省视为 false）。置 true 后整段
 * 跳过＝二次启动 no-op。
 *
 * 机判半在 legacy-wipe-smoke.ts（批 A 拆出）：smoke 名不经本模块与
 * storage 桶导出，防止冒烟面经静态图回流浏览器加载面。
 */

import { getGlobal, LEGACY_NAV_AUTO_TOP_KEY, LEGACY_NAV_QR_ACTIVATED_KEY, setGlobal } from './service';

/**
 * 旧 persona 键名（清理侧冻结副本；迁移侧的真相源＝modules/persona/storage
 * 的 LEGACY_KEYS）。自世界书勾选/钉选域退役起为 3 键——pw_wi_selection_v1/
 * pw_pinned_books_v1 已随该域退役移入 persona 侧的退休键清单，不在本段管辖。
 *
 * 本段与迁移面之间刻意不共享常量：本清单的语义是「首启一次性清理该删哪些
 * 键」——一份随首启封存的历史事实；迁移侧的键表则随迁移面演进。两者共用
 * 一份字面量会把历史快照变成当前迁移面的镜像，将来迁移面加键就会顺手把
 * 键塞进清理清单（迁移键从不被本段删），语义混淆且跨层依赖 storage→modules。
 * 两侧字面量漂移的代价有界：漂了也只是少删一个用户早已不用的本地键，
 * 不碰任何已迁移数据。
 */
// 导出＝smoke 侧夹具（legacy-wipe-smoke seedAll）按同一名单种子，字面量仅此一份
export const LEGACY_PERSONA_STATE_KEY = 'pw_state_v20';
export const LEGACY_PERSONA_UI_STATE_KEY = 'pw_ui_state_v4_preset';
export const LEGACY_PERSONA_DATA_USER_KEY = 'pw_data_user_v1';

/**
 * 清理键清单：persona 侧冻结副本（上条三个常量）＋nav 两个迁移源键（storage
 * 服务自持的常量，与迁移面同层，禁在别处另写第二份）。
 */
export const LEGACY_WIPE_KEYS: readonly string[] = [
    LEGACY_PERSONA_STATE_KEY,
    LEGACY_PERSONA_UI_STATE_KEY,
    LEGACY_PERSONA_DATA_USER_KEY,
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
    if (getGlobal(LEGACY_WIPE_FLAG_KEY) === true) {
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
