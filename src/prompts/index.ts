/**
 * 提示词子系统导出面。
 */
export type {
    AssemblyMessage,
    ChoiceInjectionSource,
    InjectModule,
    InjectionSource,
    ModuleTrace,
    PersonaInjectionSource,
    PromptConfig,
    PromptModule,
    PromptRole,
    StoryDirection,
    SummaryInjectionSource,
    TaskKey,
    TextModule,
} from './types';
export { PERSONA_INJECTION_SOURCES, SUMMARY_INJECTION_SOURCES, TASK_KEYS } from './types';
export { assembleMessages, historyToMessages, type AssemblySources, type PersonaAssemblySources, type SummaryAssemblySources, type AssemblyResult, type HistoryEntry, type PoolEntryLine, type PoolInjectionSupply } from './engine';
export { collectAssemblySources } from './sources';
// 复核模块只暴露「组装入口」与「任务头」两个符号：指令正文与 TextModule 一律
// 不外露（可编辑面会把一份返回格式契约交给用户改坏，而改坏只静默降级）。
export { assemblePersonaReviewMessages, PERSONA_REVIEW_TASK_HEAD } from './review';
export {
    DEFAULTS_VERSION,
    createDefaultPromptConfig,
    createTaskDefaultConfig,
    PERSONA_CURATOR_TASK_HEAD,
    PERSONA_GEN_TASK_HEAD,
} from './defaults';
export { ensurePromptConfigs, GLOBAL_PROMPT_CONFIGS_KEY } from './storage';
export { usePromptsStore } from './store';
export { renderDump, renderTraceCompact } from './dump';
