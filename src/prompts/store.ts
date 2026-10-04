/**
 * 提示词子系统 store（Pinia）。
 *
 * 真相源纪律（批A nav store 同款）：storage 域是宿主的非响应式对象，
 * 全部读取走 getGlobal/getChat 读透传、写入走写穿 action＋revision bump
 * 失效信号；store 不落值快照（快照＝第二真相源）。
 *
 * 存储落点（方案 §2.2）：
 *   - 全局域 extension_settings.ttToolkit：promptConfigs（含 modules）、
 *     promptActiveId、externalInjections（外部注入搬运配置）、
 *     directionPresets（用户自建走向预设列表——G4）；
 *   - 聊天域 chat_metadata.ttToolkit：storyDirection（已应用预设正文
 *     ＋自由文本）——写走 writeChatMetadata 立即保存通道。
 */
import { defineStore } from 'pinia';
import { getChat, getGlobal, setChat, setGlobal } from '@/storage';
import { createDefaultPromptConfig } from './defaults';
import type { DirectionPreset, ExternalInjectionConfig, PromptConfig, StoryDirection } from './types';

const GLOBAL_PROMPT_CONFIGS_KEY = 'promptConfigs';
const GLOBAL_PROMPT_ACTIVE_KEY = 'promptActiveId';
const GLOBAL_EXTERNAL_KEY = 'externalInjections';
const GLOBAL_DIRECTION_PRESETS_KEY = 'directionPresets';
const CHAT_STORY_DIRECTION_KEY = 'storyDirection';

/** 全局域整体结构（批B 落的 prompts 命名空间；choice 侧另有自己的键）。 */
export interface PromptGlobalDomain {
    promptConfigs: PromptConfig[];
    promptActiveId: string;
    externalInjections: ExternalInjectionConfig;
}

const DEFAULT_EXTERNAL: ExternalInjectionConfig = { selectedSlots: [], baibai: false };

function readPromptDomain(): PromptGlobalDomain {
    const configs = getGlobal<PromptConfig[]>(GLOBAL_PROMPT_CONFIGS_KEY);
    const activeId = getGlobal<string>(GLOBAL_PROMPT_ACTIVE_KEY);
    const external = getGlobal<ExternalInjectionConfig>(GLOBAL_EXTERNAL_KEY);
    let list = Array.isArray(configs) ? configs : [];
    if (list.length === 0) {
        // 首次启动：落默认模板集（一次性写穿；后续不再覆盖）
        list = [createDefaultPromptConfig()];
        setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, list);
    }
    return {
        promptConfigs: list,
        promptActiveId: typeof activeId === 'string' ? activeId : list[0]?.id ?? '',
        externalInjections: { ...DEFAULT_EXTERNAL, ...(external ?? {}) },
    };
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
        activeConfigId(): string {
            void this.revision;
            return readPromptDomain().promptActiveId;
        },
        /** 当前生效配置（批B 无 chat/character 绑定：activeId 直取；批C 接覆盖式解析） */
        effectiveConfig(): PromptConfig | null {
            void this.revision;
            const d = readPromptDomain();
            return d.promptConfigs.find(c => c.id === d.promptActiveId) ?? d.promptConfigs[0] ?? null;
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
        setActiveConfig(id: string) {
            const d = readPromptDomain();
            if (!d.promptConfigs.some(c => c.id === id)) return;
            setGlobal(GLOBAL_PROMPT_ACTIVE_KEY, id);
            this.revision++;
        },
        createConfig(name: string, base: PromptConfig): string {
            const id = `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const d = readPromptDomain();
            setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, [...d.promptConfigs, { id, name, modules: base.modules.map(m => ({ ...m })) }]);
            setGlobal(GLOBAL_PROMPT_ACTIVE_KEY, id);
            this.revision++;
            return id;
        },
        duplicateConfig(id: string) {
            const d = readPromptDomain();
            const src = d.promptConfigs.find(c => c.id === id);
            if (!src) return;
            this.createConfig(`${src.name}（副本）`, src);
        },
        renameConfig(id: string, name: string) {
            const d = readPromptDomain();
            setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, d.promptConfigs.map(c => (c.id === id ? { ...c, name } : c)));
            this.revision++;
        },
        deleteConfig(id: string) {
            const d = readPromptDomain();
            if (d.promptConfigs.length <= 1) return; // 最后一套不许删（真相源不能空）
            const rest = d.promptConfigs.filter(c => c.id !== id);
            setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, rest);
            if (d.promptActiveId === id) {
                setGlobal(GLOBAL_PROMPT_ACTIVE_KEY, rest[0]?.id ?? '');
            }
            this.revision++;
        },
        /** 整体替换某配置的模块集（编辑器写回——直接编辑当前生效配置） */
        replaceModules(id: string, modules: PromptConfig['modules']) {
            const d = readPromptDomain();
            setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, d.promptConfigs.map(c => (c.id === id ? { ...c, modules } : c)));
            this.revision++;
        },
        /** 单模块启停（编辑器高频操作：读-改-写整集） */
        toggleModule(configId: string, moduleId: string, enabled: boolean) {
            const d = readPromptDomain();
            const cfg = d.promptConfigs.find(c => c.id === configId);
            if (!cfg) return;
            this.replaceModules(configId, cfg.modules.map(m => (m.id === moduleId ? { ...m, enabled } : m)));
        },
        /** 模块排序交换（order 值互换——相邻上移/下移） */
        moveModule(configId: string, moduleId: string, direction: -1 | 1) {
            const d = readPromptDomain();
            const cfg = d.promptConfigs.find(c => c.id === configId);
            if (!cfg) return;
            const sorted = [...cfg.modules].sort((a, b) => a.order - b.order);
            const idx = sorted.findIndex(m => m.id === moduleId);
            const target = idx + direction;
            if (idx < 0 || target < 0 || target >= sorted.length) return;
            const orderA = sorted[idx].order;
            sorted[idx] = { ...sorted[idx], order: sorted[target].order };
            sorted[target] = { ...sorted[target], order: orderA };
            this.replaceModules(configId, sorted);
        },
        /** 编辑文本模块内容（编辑器 textarea 写回） */
        updateModuleContent(configId: string, moduleId: string, content: string) {
            const d = readPromptDomain();
            const cfg = d.promptConfigs.find(c => c.id === configId);
            if (!cfg) return;
            this.replaceModules(
                configId,
                cfg.modules.map(m => (m.id === moduleId && m.kind === 'text' ? { ...m, content } : m)),
            );
        },
        /** 编辑模块角色 */
        updateModuleRole(configId: string, moduleId: string, role: PromptConfig['modules'][number]['role']) {
            const d = readPromptDomain();
            const cfg = d.promptConfigs.find(c => c.id === configId);
            if (!cfg) return;
            this.replaceModules(configId, cfg.modules.map(m => (m.id === moduleId ? { ...m, role } : m)));
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
        /** 外部注入槽位勾选切换 */
        toggleSlot(key: string, checked: boolean) {
            const current = readPromptDomain().externalInjections;
            const set = new Set(current.selectedSlots);
            if (checked) set.add(key);
            else set.delete(key);
            this.setExternalInjections({ selectedSlots: [...set] });
        },
    },
});
