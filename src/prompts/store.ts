/**
 * 提示词子系统 store（Pinia）。
 *
 * 真相源纪律（批A nav store 同款）：storage 域是宿主的非响应式对象，
 * 全部读取走 getGlobal/getChat 读透传、写入走写穿 action＋revision bump
 * 失效信号；store 不落值快照（快照＝第二真相源）。
 *
 * 存储落点（方案 §2.2；整合轮II 升 Record）：
 *   - 全局域 extension_settings.ttToolkit：promptConfigs
 *     （Record<taskKey, PromptConfig>，四任务各一套——choice 选项生成＋
 *     persona 策展/填充/润色；旧数组档读侧迁移为 {choice: 旧生效套}，
 *     一次性写回，二次启动零改写）、
 *     externalInjections（外部注入搬运配置）、
 *     directionPresets（用户自建走向预设列表——G4）；
 *   - 聊天域 chat_metadata.ttToolkit：storyDirection（已应用预设正文
 *     ＋自由文本）——写走 writeChatMetadata 立即保存通道。
 *   - 批C 起读侧对旧档补插池注入模块（inject_pool_entries，缺席才补
 *     ——见 backfillPoolModules；整合轮II 起只作用于 choice 任务——
 *     persona 管线无池注入面）。
 */
import { defineStore } from 'pinia';
import { getChat, getGlobal, setChat, setGlobal } from '@/storage';
import { createDefaultPromptConfig, createTaskDefaultConfig } from './defaults';
import { TASK_KEYS, moduleGroupOf } from './types';
import type { DirectionPreset, ExternalInjectionConfig, PromptConfig, StoryDirection, TaskKey } from './types';

const GLOBAL_PROMPT_CONFIGS_KEY = 'promptConfigs';
const GLOBAL_PROMPT_ACTIVE_KEY = 'promptActiveId';
const GLOBAL_EXTERNAL_KEY = 'externalInjections';
const GLOBAL_DIRECTION_PRESETS_KEY = 'directionPresets';
const CHAT_STORY_DIRECTION_KEY = 'storyDirection';

/** 全局域整体结构（批B 落的 prompts 命名空间；choice 侧另有自己的键）。 */
export interface PromptGlobalDomain {
    /** 四任务配置（Record——整合轮II；promptActiveId 旧键随之退休，不再写入） */
    promptConfigs: Record<TaskKey, PromptConfig>;
    externalInjections: ExternalInjectionConfig;
}

const DEFAULT_EXTERNAL: ExternalInjectionConfig = { allSlots: false, selectedSlots: [], baibai: false };

/** 配置形状守门（Record 形态下逐键校验——外部写坏的键回退默认，不抛错）。 */
function isConfigShape(value: unknown): value is PromptConfig {
    return typeof value === 'object' && value !== null && Array.isArray((value as PromptConfig).modules);
}

function readPromptDomain(): PromptGlobalDomain {
    const external = getGlobal<ExternalInjectionConfig>(GLOBAL_EXTERNAL_KEY);
    const raw = getGlobal<unknown>(GLOBAL_PROMPT_CONFIGS_KEY);
    const configs: Partial<Record<TaskKey, PromptConfig>> = {};
    let changed = false;
    if (Array.isArray(raw)) {
        // 整合轮II 迁移：旧数组档（单模板时代，恒单元素）→ {choice: 当时生效套}。
        // m03359 的多套收敛语义保留（activeId 命中 ?? 首套）；一次性写回 Record 形，
        // promptActiveId 旧键读后即退休（不写不删——normalize 丢弃面自然淡出）。
        let list = raw as PromptConfig[];
        const activeId = getGlobal<string>(GLOBAL_PROMPT_ACTIVE_KEY);
        if (list.length === 0) list = [createDefaultPromptConfig()];
        else if (list.length > 1) list = [list.find(c => c.id === activeId) ?? list[0]];
        configs.choice = list[0];
        changed = true;
    } else if (raw !== null && typeof raw === 'object') {
        // 新 Record 形：逐任务键读取；未知键丢弃（normalize 丢弃面）
        const record = raw as Record<string, unknown>;
        for (const task of TASK_KEYS) {
            if (isConfigShape(record[task])) configs[task] = record[task];
        }
    }
    // 补缺四键（首次启动全默认；旧档补 persona 三键）
    for (const task of TASK_KEYS) {
        if (configs[task]) continue;
        configs[task] = createTaskDefaultConfig(task);
        changed = true;
    }
    if (backfillPoolModules(configs.choice)) changed = true;
    if (stripRetiredPoolRules(configs.choice)) changed = true;
    if (changed) setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, configs);
    return {
        promptConfigs: configs as Record<TaskKey, PromptConfig>,
        externalInjections: { ...DEFAULT_EXTERNAL, ...(external ?? {}) },
    };
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

/** 旧档里的 inject_pool_rules 模块剔除（m03359：池规则并入 core_rules；choice 任务专属）。 */
function stripRetiredPoolRules(choice: PromptConfig | undefined): boolean {
    if (!choice || !Array.isArray(choice.modules)) return false;
    const filtered = choice.modules.filter(m => !(m.kind === 'inject' && (m as { source?: unknown }).source === 'pool_rules'));
    if (filtered.length === choice.modules.length) return false;
    choice.modules = filtered;
    return true;
}

/** 外部注入搬运配置读取（非 store 上下文消费——sources 组装路径）。 */
export function externalInjectionConfig(): ExternalInjectionConfig {
    const external = getGlobal<ExternalInjectionConfig>(GLOBAL_EXTERNAL_KEY);
    return { ...DEFAULT_EXTERNAL, ...(external ?? {}) };
}

/**
 * 启动期初始化：默认模板集落盘（幂等——已有配置不覆盖）＋旧数组档迁移。
 * 由 choice 模块初始化（浏览器与 node 冒烟两路）调用——不依赖任何 UI
 * 读方先打开设置页。
 */
export function ensurePromptConfigs(): void {
    readPromptDomain();
}

export const usePromptsStore = defineStore('tt-prompts', {
    state: () => ({
        /** 写穿计数：读透传 getter 的失效信号 */
        revision: 0,
        /** 最近一次组装结果（dump 展示态；会话内存，不持久化） */
        lastTraceText: '',
    }),
    getters: {
        /** 四任务配置全景（编辑器任务切换条/列表渲染） */
        taskConfigs(): Record<TaskKey, PromptConfig> {
            void this.revision;
            return readPromptDomain().promptConfigs;
        },
        /** 按任务取生效配置（函数式 getter——Pinia 传参惯用法） */
        configFor(): (task: TaskKey) => PromptConfig | null {
            void this.revision;
            const configs = readPromptDomain().promptConfigs;
            return task => configs[task] ?? null;
        },
        /** choice 任务生效配置（兼容惯用消费方） */
        effectiveConfig(): PromptConfig | null {
            void this.revision;
            return readPromptDomain().promptConfigs.choice ?? null;
        },
        externalInjections(): ExternalInjectionConfig {
            void this.revision;
            return readPromptDomain().externalInjections;
        },
        storyDirection(): StoryDirection {
            void this.revision;
            const d = getChat<Partial<StoryDirection>>(CHAT_STORY_DIRECTION_KEY);
            // 旧档案是 {tag, freeText} 形态（G4 前六选一标签）：tag 已废弃
            // （用户拍板固定标签不保留）——读档只取 freeText，tag 丢弃；
            // presetText 旧档案没有，缺省空串
            return {
                presetText: typeof d?.presetText === 'string' ? d.presetText : '',
                freeText: typeof d?.freeText === 'string' ? d.freeText : '',
            };
        },
        directionPresets(): DirectionPreset[] {
            void this.revision;
            const raw = getGlobal<unknown>(GLOBAL_DIRECTION_PRESETS_KEY);
            if (!Array.isArray(raw)) return [];
            // 逐项守门：外部写坏的条目（缺 id/text 或类型不对）剔除而非抛错
            // ——预设列表是用户可重建的辅助数据，不值得 Fail Fast 打断组装
            return raw.filter(
                (p): p is DirectionPreset =>
                    typeof p === 'object' && p !== null && typeof (p as DirectionPreset).id === 'string' && typeof (p as DirectionPreset).text === 'string',
            );
        },
    },
    actions: {
        /**
         * 按任务恢复默认模板（m03359 拍板新增，整合轮II 起按任务分立）：
         * 用户改坏了自己也不会修时一键回厂。整体替换该任务的 modules，
         * 不可撤销（UI 侧先 confirm）。
         */
        resetToDefault(task: TaskKey) {
            const d = readPromptDomain();
            setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, { ...d.promptConfigs, [task]: createTaskDefaultConfig(task) });
            this.revision++;
        },
        /** 整体替换指定任务模板的模块集（编辑器写回） */
        replaceModules(task: TaskKey, modules: PromptConfig['modules']) {
            const d = readPromptDomain();
            const current = d.promptConfigs[task];
            if (!current) return;
            setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, { ...d.promptConfigs, [task]: { ...current, modules } });
            this.revision++;
        },
        /** 单模块启停（编辑器高频操作：读-改-写整集） */
        toggleModule(task: TaskKey, moduleId: string, enabled: boolean) {
            const cfg = readPromptDomain().promptConfigs[task];
            if (!cfg) return;
            this.replaceModules(task, cfg.modules.map(m => (m.id === moduleId ? { ...m, enabled } : m)));
        },
        /**
         * 模块排序交换（order 值互换）。编辑器按 G5 三分组渲染，移动的
         * 交换对象限定同组相邻模块——跨组位置由各组分段天然隔开，跨组
         * 交换会让另一组里凭空多/少一行，视觉上＝乱跳。
         */
        moveModule(task: TaskKey, moduleId: string, direction: -1 | 1) {
            const cfg = readPromptDomain().promptConfigs[task];
            if (!cfg) return;
            const sorted = [...cfg.modules].sort((a, b) => a.order - b.order);
            const idx = sorted.findIndex(m => m.id === moduleId);
            if (idx < 0) return;
            const group = moduleGroupOf(sorted[idx]);
            let target = idx + direction;
            while (target >= 0 && target < sorted.length && moduleGroupOf(sorted[target]) !== group) {
                target += direction;
            }
            if (target < 0 || target >= sorted.length) return;
            const orderA = sorted[idx].order;
            sorted[idx] = { ...sorted[idx], order: sorted[target].order };
            sorted[target] = { ...sorted[target], order: orderA };
            this.replaceModules(task, sorted);
        },
        /** 编辑文本模块内容（编辑器 textarea 写回） */
        updateModuleContent(task: TaskKey, moduleId: string, content: string) {
            const cfg = readPromptDomain().promptConfigs[task];
            if (!cfg) return;
            this.replaceModules(
                task,
                cfg.modules.map(m => (m.id === moduleId && m.kind === 'text' ? { ...m, content } : m)),
            );
        },
        setStoryDirection(patch: Partial<StoryDirection>) {
            const current = this.storyDirection;
            setChat(CHAT_STORY_DIRECTION_KEY, { ...current, ...patch });
            this.revision++;
        },
        /** 把当前自由文本存为预设（G4：「我的预设」可添加当前文本为预设）。 */
        addDirectionPreset(text: string): void {
            const value = text.trim();
            if (!value) return;
            const preset: DirectionPreset = { id: `dir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, text: value };
            setGlobal(GLOBAL_DIRECTION_PRESETS_KEY, [...this.directionPresets, preset]);
            this.revision++;
        },
        deleteDirectionPreset(id: string): void {
            // 只删全局列表；已应用聊天存的是正文快照，不受影响（见 types
            // 注释——快照自包含，删除预设不清空已应用的走向）
            setGlobal(GLOBAL_DIRECTION_PRESETS_KEY, this.directionPresets.filter(p => p.id !== id));
            this.revision++;
        },
        setExternalInjections(patch: Partial<ExternalInjectionConfig>) {
            const current = readPromptDomain().externalInjections;
            setGlobal(GLOBAL_EXTERNAL_KEY, { ...current, ...patch });
            this.revision++;
        },
        /** 外部注入槽位勾选切换（旧白名单路径——UI 已改全搬开关，保留供旧数据/程序路径） */
        toggleSlot(key: string, checked: boolean) {
            const current = readPromptDomain().externalInjections;
            const set = new Set(current.selectedSlots);
            if (checked) set.add(key);
            else set.delete(key);
            this.setExternalInjections({ selectedSlots: [...set] });
        },
    },
});
