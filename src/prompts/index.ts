/**
 * 提示词子系统导出面。
 */
export type {
    AssemblyMessage,
    ChoiceInjectionSource,
    DirectionPreset,
    InjectModule,
    InjectionSource,
    ModuleGroupId,
    ModuleTrace,
    PersonaInjectionSource,
    PromptConfig,
    PromptModule,
    PromptRole,
    StoryDirection,
    TaskKey,
    TextModule,
} from './types';
export { moduleGroupOf, TASK_KEYS } from './types';
export { assembleMessages, historyToMessages, type AssemblySources, type PersonaAssemblySources, type AssemblyResult, type HistoryEntry, type PoolEntryLine, type PoolInjectionSupply } from './engine';
export { collectAssemblySources } from './sources';
export { createDefaultPromptConfig, createTaskDefaultConfig } from './defaults';
export { getBaibaiSummary } from './external';
export { usePromptsStore, ensurePromptConfigs, type PromptGlobalDomain } from './store';
export { renderDump, renderTraceCompact } from './dump';
