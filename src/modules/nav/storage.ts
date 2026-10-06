/**
 * nav 域的存储读写便捷口：域形状与迁移在 storage/service（GlobalDomain.nav），
 * 便捷读写归 nav 模块自持——storage 服务不感知具体功能域的读写形态。
 */

// 直连 service 而非 '@/storage' barrel：barrel 再导出 legacy-wipe，而
// legacy-wipe 消费本模块——经 barrel 会成 storage↔modules 环（persona/storage 同款避环惯例）
import { getGlobal, setGlobal } from '@/storage/service';
import type { NavStorageState } from '@/storage/service';

/** nav 域缺省态（域缺席/形状损坏时回退）。 */
const NAV_DEFAULTS: NavStorageState = { qrActivated: false };

/** nav 域便捷读取（getGlobal 深快照，返回值与存储单例解耦）。 */
export function getNavState(): NavStorageState {
    const nav = getGlobal<NavStorageState>('nav');
    if (!nav || typeof nav !== 'object' || Array.isArray(nav)) return { ...NAV_DEFAULTS };
    return nav;
}

/** nav 域便捷写入（读改写整体替换该子域）。 */
export function setNavState(patch: Partial<NavStorageState>): void {
    setGlobal('nav', { ...getNavState(), ...patch });
}
