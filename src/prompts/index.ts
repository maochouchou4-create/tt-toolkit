/**
 * 提示词子系统导出面。
 */
export type {
    AssemblyMessage,
    ExternalInjectionConfig,
    InjectModule,
    InjectionSource,
    ModuleTrace,
    PromptConfig,
    PromptModule,
    PromptRole,
    StoryDirection,
    StoryDirectionTag,
    TextModule,
} from './types';
export { STORY_DIRECTION_TAG_DEFS, directionLabelOf } from './directions';
export { assembleMessages, historyToMessages, type AssemblySources, type AssemblyResult, type HistoryEntry } from './engine';
export { collectAssemblySources } from './sources';
export { createDefaultPromptConfig, createPromptConfigFromDefault } from './defaults';
export { getBaibaiSummary, listSlotPreviews, type SlotPreview } from './external';
export { usePromptsStore, externalInjectionConfig, ensurePromptConfigs, type PromptGlobalDomain } from './store';
export { validatePromptModules, type PromptModulesValidation } from './validate';
export { renderDump, renderTraceCompact } from './dump';
