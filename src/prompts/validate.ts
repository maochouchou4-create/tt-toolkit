/**
 * 提示词配置导入契约校验（Parse, don't validate 的导入边界——数据
 * 治理选源头：导入文件是外部不可信输入，落盘前显式校验并给出可读
 * 错误，不做「部分落盘＋悄悄容忍」）。
 *
 * 手写逐字段校验而非 Zod：校验面只有本结构一处（引依赖的收益盖不过
 * 新增依赖面），且错误文案要给到「第几个模块、哪个字段、期望什么」
 * 的可读粒度。
 */
import type { InjectionSource, PromptModule, PromptRole } from './types';

const ROLES: readonly PromptRole[] = ['system', 'user', 'assistant'];
const INJECTION_SOURCES: readonly InjectionSource[] = [
    'persona',
    'char_description',
    'char_personality',
    'char_scenario',
    'world_info_before',
    'world_info_after',
    'wi_depth_before',
    'wi_depth_after',
    'chat_history',
    'story_direction',
    'external_slot',
    'baibai',
    'pool_entries',
    'pool_rules',
];

export type PromptModulesValidation =
    | { ok: true; modules: PromptModule[] }
    | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldError(index: number, field: string, expect: string): string {
    return `modules[${index}].${field} ${expect}`;
}

function validateModule(item: unknown, index: number): string | null {
    if (!isObject(item)) return fieldError(index, '', '必须是对象');
    if (item.kind !== 'text' && item.kind !== 'inject') {
        return fieldError(index, 'kind', '必须是 "text" 或 "inject"');
    }
    if (typeof item.id !== 'string' || item.id.trim() === '') {
        return fieldError(index, 'id', '必须是非空字符串');
    }
    if (typeof item.name !== 'string' || item.name.trim() === '') {
        return fieldError(index, 'name', '必须是非空字符串');
    }
    if (typeof item.order !== 'number' || !Number.isFinite(item.order)) {
        return fieldError(index, 'order', '必须是有限数字');
    }
    if (typeof item.enabled !== 'boolean') {
        return fieldError(index, 'enabled', '必须是布尔值');
    }
    if (!ROLES.includes(item.role as PromptRole)) {
        return fieldError(index, 'role', `必须是 ${ROLES.map(r => `"${r}"`).join(' / ')} 之一`);
    }
    if (item.kind === 'text') {
        if (typeof item.content !== 'string') {
            return fieldError(index, 'content', '必须是字符串');
        }
        return null;
    }
    if (!INJECTION_SOURCES.includes(item.source as InjectionSource)) {
        return fieldError(index, 'source', `必须是 ${INJECTION_SOURCES.map(s => `"${s}"`).join(' / ')} 之一`);
    }
    return null;
}

/**
 * 校验导入的模块数组。全部通过返回规整后的模块集（仅收敛类型，不改
 * 值）；任一字段不合约返回带定位的可读错误（调用方拒绝导入，零落盘）。
 */
export function validatePromptModules(value: unknown): PromptModulesValidation {
    if (!Array.isArray(value)) return { ok: false, error: 'modules 必须是数组' };
    if (value.length === 0) return { ok: false, error: 'modules 不能为空（配置至少要有一个模块）' };
    for (let i = 0; i < value.length; i++) {
        const problem = validateModule(value[i], i);
        if (problem) return { ok: false, error: problem };
    }
    return { ok: true, modules: value as PromptModule[] };
}
