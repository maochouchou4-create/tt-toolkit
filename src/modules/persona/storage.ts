/**
 * persona 存储域。
 *
 * 数据落点：extension_settings.ttToolkit.persona 全局域（经 storage 层
 * getGlobal/setGlobal 单通道）。域形状 normalize 纪律照 choice/pool：
 * 未知字段丢弃（显式保真注释），缺字段补默认，反复读写幂等。
 *
 * 本域只剩 userContext（编辑现场）：端点身份（url/key）住统一服务商表
 * （modules/apis），模型选择权在任务档案（apis/task-profiles），流式/超时
 * 按任务固化于 TASK_PARAMS。旧档的 localConfig 键（含 v1.3 endpointId、
 * v1.4 过渡端点字段）、uiState 键（任务级预设选择）与世界书勾选/钉选域
 * 字段（wiSelection/pinnedBooks/extraBooks）都随 tt-slim 批 B 历史机器
 * 退役——normalize 的未知字段丢弃面负责把存量档里的这些残留洗掉。
 */

import { getGlobal, setGlobal } from '@/storage/service';

/** persona 域键（extension_settings.ttToolkit 下）。 */
export const PERSONA_DOMAIN_KEY = 'persona';

/** 编辑现场暂存（需求框/结果框）。 */
export interface UserContext {
    request: string;
    result: string;
}

/** persona 全局域形状。 */
export interface PersonaDomain {
    userContext: UserContext;
}

/** 全局域键登记：键常量与域类型同处归属模块（登记面说明见 storage/service.ts）。 */
declare module '@/storage/service' {
    interface GlobalDomain {
        /** persona 域（本文件 PERSONA_DOMAIN_KEY） */
        persona?: PersonaDomain;
    }
}

// ============================================================================
// normalize（域形状保真：未知字段丢弃，缺字段补默认）
// ============================================================================

function normalizeString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

function normalizeUserContext(value: unknown): UserContext {
    // 逐字段重建：旧形状的 template/curatedSchema/hasResult 字段丢弃
    // （前两者已淘汰；hasResult 可由 result 派生，恒真值不落盘）
    const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    return {
        request: normalizeString(raw.request, ''),
        result: normalizeString(raw.result, ''),
    };
}

/** 域 normalize（未知字段丢弃：本域无任何透传字段，新增字段须显式声明）。 */
export function normalizePersonaDomain(value: unknown): PersonaDomain {
    const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    return {
        userContext: normalizeUserContext(raw.userContext),
    };
}

// ============================================================================
// 域读写（读-改-写单通道，照 choice/api.ts 纪律）
// ============================================================================

export function readPersonaDomain(): PersonaDomain {
    return normalizePersonaDomain(getGlobal(PERSONA_DOMAIN_KEY));
}

export function writePersonaDomain(mutate: (domain: PersonaDomain) => void): PersonaDomain {
    const domain = readPersonaDomain();
    mutate(domain);
    const normalized = normalizePersonaDomain(domain);
    setGlobal(PERSONA_DOMAIN_KEY, normalized);
    return normalized;
}
