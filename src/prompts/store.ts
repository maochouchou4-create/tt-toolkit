/**
 * 提示词子系统 store（Pinia）。
 *
 * 真相源纪律（批A nav store 同款）：storage 域是宿主的非响应式对象，
 * 全部读取走 getGlobal/getChat 读透传、写入走写穿 action＋revision bump
 * 失效信号；store 不落值快照（快照＝第二真相源）。
 *
 * 存储落点（方案 §2.2；整合轮II 升 Record）：
 *   - 全局域 extension_settings.ttToolkit：promptConfigs
 *     （Record<taskKey, PromptConfig>，三任务各一套——choice 选项生成＋
 *     persona 策展/填充；旧数组档读侧迁移为 {choice: 旧生效套}，
 *     一次性写回，二次启动零改写）、
 *     directionPresets（用户自建走向预设列表——G4）；
 *     整合轮II 验收修整：externalInjections 键随编辑面删除而退休
 *     （外部注入改全自动，无人读旧值——normalize 丢弃面自然淡出，
 *     不做迁移）。
 *   - 聊天域 chat_metadata.ttToolkit：storyDirection（已应用预设正文
 *     ＋自由文本）——写走 writeChatMetadata 立即保存通道。
 *   - 批C 起读侧对旧档补插池注入模块（inject_pool_entries，缺席才补
 *     ——见 backfillPoolModules；整合轮II 起只作用于 choice 任务——
 *     persona 管线无池注入面）。
 *   - 模板编辑面已随提示词 tab 删除（整合轮II 验收修整）：模板内置
 *     于代码（defaults），engine 照常读；编辑 actions（replaceModules/
 *     toggleModule/moveModule/updateModuleContent）随之退役。resetToDefault
 *     保留（smoke「按任务恢复默认」红线在用）。modules[].enabled 仍由
 *     引擎消费（行为面，非 UI 面）。
 */
import { defineStore } from 'pinia';
import { getChat, getGlobal, newId, setChat, setGlobal } from '@/storage';
import { createDefaultPromptConfig, createTaskDefaultConfig } from './defaults';
import { TASK_KEYS } from './types';
import type { DirectionPreset, PromptConfig, StoryDirection, TaskKey } from './types';

const GLOBAL_PROMPT_CONFIGS_KEY = 'promptConfigs';
const GLOBAL_PROMPT_ACTIVE_KEY = 'promptActiveId';
const GLOBAL_DIRECTION_PRESETS_KEY = 'directionPresets';
const CHAT_STORY_DIRECTION_KEY = 'storyDirection';

/** 全局域整体结构（批B 落的 prompts 命名空间；choice 侧另有自己的键）。 */
export interface PromptGlobalDomain {
    /** 三任务配置（Record——整合轮II；promptActiveId 旧键随之退休，不再写入） */
    promptConfigs: Record<TaskKey, PromptConfig>;
}

/** 配置形状守门（Record 形态下逐键校验——外部写坏的键回退默认，不抛错）。 */
function isConfigShape(value: unknown): value is PromptConfig {
    return typeof value === 'object' && value !== null && Array.isArray((value as PromptConfig).modules);
}

function readPromptDomain(): PromptGlobalDomain {
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
    // 补缺三键（首次启动全默认；旧档补 persona 两键；存量已退休任务键的
    // 配置读侧出局——TASK_KEYS 收窄后未知键在写回时自然消失）
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
        /** 三任务配置全景（编辑面已删；读侧 getter 保留——任务域枚举口） */
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
         * 整体替换该任务的 modules，不可撤销。提示词编辑面已删除（整合轮
         * II 验收修整），本 action 无 UI 入口，保留供冒烟红线（persona
         * smoke「按任务恢复默认」断言——旧档迁移后的还原通道）。
         */
        resetToDefault(task: TaskKey) {
            const d = readPromptDomain();
            setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, { ...d.promptConfigs, [task]: createTaskDefaultConfig(task) });
            this.revision++;
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
            const preset: DirectionPreset = { id: newId('dir'), text: value };
            setGlobal(GLOBAL_DIRECTION_PRESETS_KEY, [...this.directionPresets, preset]);
            this.revision++;
        },
        deleteDirectionPreset(id: string): void {
            // 只删全局列表；已应用聊天存的是正文快照，不受影响（见 types
            // 注释——快照自包含，删除预设不清空已应用的走向）
            setGlobal(GLOBAL_DIRECTION_PRESETS_KEY, this.directionPresets.filter(p => p.id !== id));
            this.revision++;
        },
    },
});
