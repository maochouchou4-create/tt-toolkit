/**
 * nav 域的存储读写便捷口：域形状在 storage/service（GlobalDomain.nav），
 * 便捷读写归 nav 模块自持——storage 服务不感知具体功能域的读写形态。
 */

// 直连 service 而非 '@/storage' barrel：barrel 在入口静态图上，功能模块经
// 桶取底层服务会徒增入口加载面的耦合面（persona/storage 同款惯例）
import { getGlobal, setGlobal } from '@/storage/service';
import type { NavStorageState } from '@/storage/service';

/** nav 域缺省态（域缺席/形状损坏时回退）。 */
const NAV_DEFAULTS: NavStorageState = { qrActivated: false };

/**
 * nav 域 normalize（纯函数，吃 unknown）：缺省/非对象归缺省，其余原样透传
 * ——本域只有布尔标记面，没有需要逐字段重建的复合字段（退役字段的丢弃由
 * 启动期 initStorage 的剥离段负责，见 storage/service）。
 */
export function normalizeNavState(raw: unknown): NavStorageState {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...NAV_DEFAULTS };
    return raw as NavStorageState;
}

/** nav 域便捷读取（getGlobal 深快照后归一；返回值与存储单例解耦）。 */
export function getNavState(): NavStorageState {
    return normalizeNavState(getGlobal('nav'));
}

/** nav 域便捷写入（读改写整体替换该子域）。 */
export function setNavState(patch: Partial<NavStorageState>): void {
    setGlobal('nav', { ...getNavState(), ...patch });
}
