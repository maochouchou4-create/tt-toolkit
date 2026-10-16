/**
 * prompts 域存储（读侧纯函数＋启动期迁移写）：其他域同构的
 * storage 分文件。真相源＝全局域 extension_settings.ttToolkit.promptConfigs
 * （Record<TaskKey, PromptConfig>，三任务各一套——choice 选项生成＋
 * persona 策展/填充）；非 Record 形态的旧档不迁移，整键重建默认并留 warn。
 *
 * 读路径零副作用：getter 只做内存 normalize（补缺/形状守门），不写回；
 * 落盘统一由 ensurePromptConfigs 在启动期完成（choice 模块 init
 * 调用——浏览器与 node 冒烟两路，不依赖任何 UI 读方先打开设置页）。
 */

import { getGlobal, setGlobal } from '@/storage';
import { DEFAULTS_VERSION, POOL_ENTRIES_MODULE, createTaskDefaultConfig } from './defaults';
import { TASK_KEYS } from './types';
import type { PromptConfig, TaskKey } from './types';

/** 全局域提示词配置集键（冒烟机判直接按此键构造/恢复域，禁第二份字面量）。 */
export const GLOBAL_PROMPT_CONFIGS_KEY = 'promptConfigs';

/** 全局域键登记：键常量与域类型同处归属模块（登记面说明见 storage/service.ts）。 */
declare module '@/storage/service' {
    interface GlobalDomain {
        /** 提示词配置集（本文件 GLOBAL_PROMPT_CONFIGS_KEY） */
        promptConfigs?: Record<TaskKey, PromptConfig>;
    }
}

/** 配置形状守门（Record 形态下逐键校验——外部写坏的键回退默认，不抛错）。 */
function isConfigShape(value: unknown): value is PromptConfig {
    return typeof value === 'object' && value !== null && Array.isArray((value as PromptConfig).modules);
}

/**
 * 池注入模块补建（choice 任务专属——persona 管线无池注入面；就地修改，
 * 返回是否有改动）。双复核 P3 修复语义保留：按 source 在场判断——缺席才
 * 补，幂等。模块本体取出厂模板那一份常量（defaults 的 POOL_ENTRIES_MODULE
 * ），补出来的身份必须与新装模板完全一致，否则引擎见到的会是一个 source
 * 对得上、id/order 对不上的四不像模块。
 */
function backfillPoolModules(choice: PromptConfig | undefined): boolean {
    if (!choice || !Array.isArray(choice.modules)) return false;
    if (choice.modules.some(m => m.kind === 'inject' && m.source === 'pool_entries')) return false;
    choice.modules.push({ ...POOL_ENTRIES_MODULE });
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
 * 存储原值 → 各任务键 Record（纯函数，不触碰 storage）。
 *
 * 域形状只认 Record：逐任务键按形状校验读取，未知键丢弃（normalize 丢弃面）、
 * 缺席任务键补默认（首次启动全默认；存量已退休任务键的配置读侧出局——
 * TASK_KEYS 收窄后未知键在写回时自然消失）。
 *
 * **非 Record 形态（旧数组档与一切非对象原值）整键重建默认并留一条 warn**：
 * 重建会丢掉用户编辑过的提示词，是可感知的数据重置——静默做等于让用户对着
 * 空模板以为自己只是「没生效」。空域（键缺席，首次启动）不是这一类，不留痕。
 */
function normalizePromptConfigs(raw: unknown): { configs: Record<TaskKey, PromptConfig>; changed: boolean } {
    const configs: Partial<Record<TaskKey, PromptConfig>> = {};
    let changed = false;
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const record = raw as Record<string, unknown>;
        for (const task of TASK_KEYS) {
            if (isConfigShape(record[task])) configs[task] = record[task];
        }
    } else if (raw !== null && raw !== undefined) {
        console.warn(`tt-toolkit：${GLOBAL_PROMPT_CONFIGS_KEY} 域形状不可判定（非 Record），已整键重建为默认提示词——用户编辑过的内容不再保留`);
        changed = true;
    }
    for (const task of TASK_KEYS) {
        if (configs[task]) continue;
        configs[task] = createTaskDefaultConfig(task);
        changed = true;
    }
    // 默认配置版本化重建：任务键无编辑面＝default 配置只能是旧默认
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

/** 读各任务键配置（纯读：只做内存 normalize，不写 storage——读路径零副作用）。 */
export function readPromptConfigs(): Record<TaskKey, PromptConfig> {
    return normalizePromptConfigs(getGlobal(GLOBAL_PROMPT_CONFIGS_KEY)).configs;
}

/**
 * 启动期初始化：默认模板集落盘（幂等——已有配置不覆盖）＋旧数组档一次
 * 性迁移写回。normalize 判定有改才写；normalize 就地修改了 choice 配置
 * 内的模块数组（backfill/strip），写回的是同一份配置。
 */
export function ensurePromptConfigs(): void {
    const { configs, changed } = normalizePromptConfigs(getGlobal(GLOBAL_PROMPT_CONFIGS_KEY));
    if (changed) setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, configs);
}
