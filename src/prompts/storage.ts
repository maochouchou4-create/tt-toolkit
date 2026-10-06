/**
 * prompts 域存储（读侧纯函数＋启动期迁移写）：其他域同构的
 * storage 分文件。真相源＝全局域 extension_settings.ttToolkit.promptConfigs
 * （Record<TaskKey, PromptConfig>，三任务各一套——choice 选项生成＋
 * persona 策展/填充；旧数组档由启动 init 一次性迁移为 {choice: 旧生效套}，
 * 二次启动零改写）。
 *
 * 读路径零副作用：getter 只做内存 normalize（补缺/形状守门），不写回；
 * 落盘迁移统一由 ensurePromptConfigs 在启动期完成（choice 模块 init
 * 调用——浏览器与 node 冒烟两路，不依赖任何 UI 读方先打开设置页）。
 */

import { getGlobal, setGlobal } from '@/storage';
import { DEFAULTS_VERSION, createDefaultPromptConfig, createTaskDefaultConfig } from './defaults';
import { TASK_KEYS } from './types';
import type { PromptConfig, TaskKey } from './types';

/** 全局域提示词配置集键（冒烟机判直接按此键构造/恢复域，禁第二份字面量）。 */
export const GLOBAL_PROMPT_CONFIGS_KEY = 'promptConfigs';
const GLOBAL_PROMPT_ACTIVE_KEY = 'promptActiveId';

/** 配置形状守门（Record 形态下逐键校验——外部写坏的键回退默认，不抛错）。 */
function isConfigShape(value: unknown): value is PromptConfig {
    return typeof value === 'object' && value !== null && Array.isArray((value as PromptConfig).modules);
}

/**
 * 池注入模块补建（choice 任务专属——persona 管线无池注入面；就地修改，
 * 返回是否有改动）。双复核 P3 修复语义保留：按 source 在场判断——缺席才
 * 补，幂等。
 */
function backfillPoolModules(choice: PromptConfig | undefined): boolean {
    if (!choice || !Array.isArray(choice.modules)) return false;
    if (choice.modules.some(m => m.kind === 'inject' && m.source === 'pool_entries')) return false;
    choice.modules.push({
        kind: 'inject',
        id: 'inject_pool_entries',
        name: '池条目',
        role: 'system',
        order: 98,
        enabled: true,
        source: 'pool_entries',
    });
    return true;
}

/** 旧档里的 inject_pool_rules 模块剔除（池规则已并入 core_rules；choice 任务专属）。 */
function stripRetiredPoolRules(choice: PromptConfig | undefined): boolean {
    if (!choice || !Array.isArray(choice.modules)) return false;
    const filtered = choice.modules.filter(m => !(m.kind === 'inject' && (m as { source?: unknown }).source === 'pool_rules'));
    if (filtered.length === choice.modules.length) return false;
    choice.modules = filtered;
    return true;
}

/**
 * 存储原值 → 三任务 Record（纯函数，不触碰 storage）。
 * 旧数组档（单模板时代，恒单元素）→ {choice: 当时生效套}（activeId 命中
 * ?? 首套）；新 Record 形逐任务键读取，未知键丢弃（normalize 丢弃面）；
 * 缺席任务键补默认（首次启动全默认；旧档补 persona 两键；存量已退休任务
 * 键的配置读侧出局——TASK_KEYS 收窄后未知键在写回时自然消失）。
 */
function normalizePromptConfigs(raw: unknown): { configs: Record<TaskKey, PromptConfig>; changed: boolean } {
    const configs: Partial<Record<TaskKey, PromptConfig>> = {};
    let changed = false;
    if (Array.isArray(raw)) {
        let list = raw as PromptConfig[];
        const activeId = getGlobal<string>(GLOBAL_PROMPT_ACTIVE_KEY);
        if (list.length === 0) list = [createDefaultPromptConfig()];
        else if (list.length > 1) list = [list.find(c => c.id === activeId) ?? list[0]];
        configs.choice = list[0];
        changed = true;
    } else if (raw !== null && typeof raw === 'object') {
        const record = raw as Record<string, unknown>;
        for (const task of TASK_KEYS) {
            if (isConfigShape(record[task])) configs[task] = record[task];
        }
    }
    for (const task of TASK_KEYS) {
        if (configs[task]) continue;
        configs[task] = createTaskDefaultConfig(task);
        changed = true;
    }
    // 默认配置版本化重建：三任务键无编辑面＝default 配置只能是旧默认
    // 快照，版本落后即整键重建（覆盖无损）；非 default 定制配置不覆盖
    // （防御分支——当前无定制来源，理论不存在）。
    for (const task of TASK_KEYS) {
        const config = configs[task]!;
        if (config.id !== 'default' || config.defaultsVersion === DEFAULTS_VERSION) continue;
        configs[task] = createTaskDefaultConfig(task);
        changed = true;
    }
    if (backfillPoolModules(configs.choice)) changed = true;
    if (stripRetiredPoolRules(configs.choice)) changed = true;
    return { configs: configs as Record<TaskKey, PromptConfig>, changed };
}

/** 读三任务配置（纯读：只做内存 normalize，不写 storage——读路径零副作用）。 */
export function readPromptConfigs(): Record<TaskKey, PromptConfig> {
    return normalizePromptConfigs(getGlobal<unknown>(GLOBAL_PROMPT_CONFIGS_KEY)).configs;
}

/**
 * 启动期初始化：默认模板集落盘（幂等——已有配置不覆盖）＋旧数组档一次
 * 性迁移写回。normalize 判定有改才写；normalize 就地修改了 choice 配置
 * 内的模块数组（backfill/strip），写回的是同一份配置。
 */
export function ensurePromptConfigs(): void {
    const { configs, changed } = normalizePromptConfigs(getGlobal<unknown>(GLOBAL_PROMPT_CONFIGS_KEY));
    if (changed) setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, configs);
}
