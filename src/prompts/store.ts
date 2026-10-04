/**
 * 提示词子系统 store（Pinia）。
 *
 * 真相源纪律（批A nav store 同款）：storage 域是宿主的非响应式对象，
 * 全部读取走 getGlobal/getChat 读透传、写入走写穿 action＋revision bump
 * 失效信号；store 不落值快照（快照＝第二真相源）。
 *
 * 存储落点（方案 §2.2）：
 *   - 全局域 extension_settings.ttToolkit：promptConfigs（含 modules；
 *     m03359 起单模板——多套旧档读侧收敛为生效那套）、
 *     externalInjections（外部注入搬运配置）、
 *     directionPresets（用户自建走向预设列表——G4）；
 *   - 聊天域 chat_metadata.ttToolkit：storyDirection（已应用预设正文
 *     ＋自由文本）——写走 writeChatMetadata 立即保存通道。
 *   - 批C 起读侧对旧存档补插池注入模块（inject_pool_entries，缺席才补
 *     ——见 readPromptDomain 的 backfillPoolModules）。
 */
import { defineStore } from 'pinia';
import { getChat, getGlobal, setChat, setGlobal } from '@/storage';
import { createDefaultPromptConfig } from './defaults';
import { moduleGroupOf } from './types';
import type { DirectionPreset, ExternalInjectionConfig, PromptConfig, StoryDirection } from './types';

const GLOBAL_PROMPT_CONFIGS_KEY = 'promptConfigs';
const GLOBAL_PROMPT_ACTIVE_KEY = 'promptActiveId';
const GLOBAL_EXTERNAL_KEY = 'externalInjections';
const GLOBAL_DIRECTION_PRESETS_KEY = 'directionPresets';
const CHAT_STORY_DIRECTION_KEY = 'storyDirection';

/** 全局域整体结构（批B 落的 prompts 命名空间；choice 侧另有自己的键）。 */
export interface PromptGlobalDomain {
    /** m03359 起恒为单元素（单模板；键形状沿用数组＝旧档迁移零改写） */
    promptConfigs: PromptConfig[];
    /** 已废弃字段位（恒取 promptConfigs[0].id）——保留只为旧档键位兼容 */
    promptActiveId: string;
    externalInjections: ExternalInjectionConfig;
}

const DEFAULT_EXTERNAL: ExternalInjectionConfig = { allSlots: false, selectedSlots: [], baibai: false };

function readPromptDomain(): PromptGlobalDomain {
    const configs = getGlobal<PromptConfig[]>(GLOBAL_PROMPT_CONFIGS_KEY);
    const activeId = getGlobal<string>(GLOBAL_PROMPT_ACTIVE_KEY);
    const external = getGlobal<ExternalInjectionConfig>(GLOBAL_EXTERNAL_KEY);
    let list = Array.isArray(configs) ? configs : [];
    if (list.length === 0) {
        // 首次启动：落默认模板（一次性写穿；后续不再覆盖）
        list = [createDefaultPromptConfig()];
        setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, list);
    } else {
        let changed = false;
        // m03359 单模板迁移：旧档多套配置收敛为当时生效那套（配置集管理面
        // 已砍除——用户拍板「懒得配置的，这一套就够了」，历史套数不保留）
        if (list.length > 1) {
            list = [list.find(c => c.id === activeId) ?? list[0]];
            changed = true;
        }
        if (backfillPoolModules(list)) changed = true;
        // 旧档里的 inject_pool_rules 模块剔除（m03359：池规则并入 core_rules，
        // 'pool_rules' 注入源已从类型层删除——留着会在引擎 switch 不可达）
        for (const config of list) {
            if (!Array.isArray(config.modules)) continue;
            const filtered = config.modules.filter(m => !(m.kind === 'inject' && (m as { source?: unknown }).source === 'pool_rules'));
            if (filtered.length !== config.modules.length) {
                config.modules = filtered;
                changed = true;
            }
        }
        if (changed) setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, list);
    }
    return {
        promptConfigs: list,
        promptActiveId: list[0]?.id ?? '',
        externalInjections: { ...DEFAULT_EXTERNAL, ...(external ?? {}) },
    };
}

/** 池注入模块补建（就地修改 list；返回是否有改动）。 */
function backfillPoolModules(list: PromptConfig[]): boolean {
    let changed = false;
    for (const config of list) {
        if (!Array.isArray(config.modules)) continue;
        // 双复核 P3 修复语义保留：按 source 在场判断——缺席才补，幂等
        if (!config.modules.some(m => m.kind === 'inject' && m.source === 'pool_entries')) {
            config.modules.push({
                kind: 'inject',
                id: 'inject_pool_entries',
                name: '池条目',
                role: 'system',
                order: 98,
                enabled: true,
                source: 'pool_entries',
            });
            changed = true;
        }
    }
    return changed;
}

/** 外部注入搬运配置读取（非 store 上下文消费——sources 组装路径）。 */
export function externalInjectionConfig(): ExternalInjectionConfig {
    const external = getGlobal<ExternalInjectionConfig>(GLOBAL_EXTERNAL_KEY);
    return { ...DEFAULT_EXTERNAL, ...(external ?? {}) };
}

/**
 * 启动期初始化：默认模板集落盘（幂等——已有配置不覆盖）＋activeId 兜底。
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
        configs(): PromptConfig[] {
            void this.revision;
            return readPromptDomain().promptConfigs;
        },
        /** 当前生效配置（m03359 单模板：promptConfigs[0]） */
        effectiveConfig(): PromptConfig | null {
            void this.revision;
            return readPromptDomain().promptConfigs[0] ?? null;
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
         * 恢复默认模板（m03359 拍板新增）：单模板的自救口——用户改坏了自己
         * 也不会修时一键回厂；也是 A/B 盲评的 B 面（改完与默认互相对照）。
         * 整体替换 modules，不可撤销（UI 侧先 confirm）。
         */
        resetToDefault() {
            setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, [createDefaultPromptConfig()]);
            this.revision++;
        },
        /** 整体替换当前模板的模块集（编辑器写回——单模板直改） */
        replaceModules(modules: PromptConfig['modules']) {
            const d = readPromptDomain();
            setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, d.promptConfigs.map((c, i) => (i === 0 ? { ...c, modules } : c)));
            this.revision++;
        },
        /** 单模块启停（编辑器高频操作：读-改-写整集） */
        toggleModule(moduleId: string, enabled: boolean) {
            const cfg = readPromptDomain().promptConfigs[0];
            if (!cfg) return;
            this.replaceModules(cfg.modules.map(m => (m.id === moduleId ? { ...m, enabled } : m)));
        },
        /**
         * 模块排序交换（order 值互换）。编辑器按 G5 三分组渲染，移动的
         * 交换对象限定同组相邻模块——跨组位置由各组分段天然隔开，跨组
         * 交换会让另一组里凭空多/少一行，视觉上＝乱跳。
         */
        moveModule(moduleId: string, direction: -1 | 1) {
            const cfg = readPromptDomain().promptConfigs[0];
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
            this.replaceModules(sorted);
        },
        /** 编辑文本模块内容（编辑器 textarea 写回） */
        updateModuleContent(moduleId: string, content: string) {
            const cfg = readPromptDomain().promptConfigs[0];
            if (!cfg) return;
            this.replaceModules(
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
