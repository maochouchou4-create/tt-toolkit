/**
 * 宿主请求头适配（CSRF token 等）。
 *
 * 三级降级：ESM 直接导入 → 宿主版本漂移时降级 context 转发 → 再缺则
 * 裸头（无 CSRF 大概率 403，错误信息仍可判读——Fail Fast 语义交给
 * 响应层）。核实记录沿客户端文件头：script.js:1041 getRequestHeaders()，
 * st-context.js:135 经 getContext() 暴露。
 */
import { getRequestHeaders as stGetRequestHeaders } from '@sillytavern/script';
import { getTavernContext } from './context';

/** 请求头（生成端点等宿主前端路由调用前装配）。 */
export function getTavernRequestHeaders(): Record<string, string> {
    try {
        const h = stGetRequestHeaders();
        if (h && typeof h === 'object') return h as Record<string, string>;
    } catch {
        // ESM 导入抛错＝宿主版本漂移，走 context 通道
    }
    const fromContext = getTavernContext()?.getRequestHeaders as (() => Record<string, string>) | undefined;
    if (typeof fromContext === 'function') {
        try {
            return fromContext();
        } catch {
            // 双通道都坏：发裸头（见文件头）
        }
    }
    return { 'Content-Type': 'application/json' };
}
