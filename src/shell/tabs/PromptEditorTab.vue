<template>
  <!--
    提示词编辑器（G5 信息架构重写）：顶部白话说明＋三分组——①核心模板
    （文本模块）②上下文注入（现场数据开关＋每项说明）③高级（外部插件
    内容搬运）。dump/trace 类调试面收进调试 tab，主编辑面不出现。
    单一真相源：直接编辑当前生效配置的 modules[]（无工作副本——fork 双
    真相源病不继承）。
  -->
  <div class="tt-prompt-editor-tab">
    <div class="tt-prompt-intro">
      这里编辑的是选项生成时发给 AI 的完整指令模板——改任何一块，下一次生成就生效。
    </div>

    <div class="tt-prompt-section-title">核心模板</div>
    <div class="tt-card">
      <div class="tt-card-title">配置集</div>
      <div class="tt-card-sub">可保存多套模板并随时切换；下方所有编辑都落在当前生效的这套里。</div>
      <div class="tt-actions">
        <button type="button" @click="createConfig">新建（复制当前）</button>
      </div>
      <ul class="tt-prompt-config-list">
        <li v-for="cfg in prompts.configs" :key="cfg.id" class="tt-prompt-config-row" :class="{ 'tt-prompt-config-row--active': cfg.id === prompts.activeConfigId }">
          <button type="button" class="tt-prompt-config-activate" :title="cfg.id === prompts.activeConfigId ? '当前生效配置' : '点选为生效配置'" @click="prompts.setActiveConfig(cfg.id)">
            {{ cfg.id === prompts.activeConfigId ? '生效中' : '启用' }}
          </button>
          <span class="tt-prompt-config-name" :title="cfg.name">{{ cfg.name }}</span>
          <span class="tt-prompt-config-count">{{ cfg.modules.length }} 模块</span>
          <span class="tt-prompt-config-ops">
            <button type="button" title="重命名" @click="renameConfig(cfg)">改名</button>
            <button type="button" title="复制为新配置" @click="prompts.duplicateConfig(cfg.id)">复制</button>
            <button type="button" title="导出 JSON" @click="exportConfig(cfg)">导出</button>
            <button v-if="prompts.configs.length > 1" type="button" class="tt-prompt-config-op-danger" title="删除" @click="confirmDelete(cfg)">删除</button>
          </span>
        </li>
      </ul>
      <div class="tt-actions" style="margin-top: 6px">
        <button type="button" @click="importConfig">导入 JSON</button>
        <input ref="importFileInput" type="file" accept=".json,application/json" style="display: none" @change="onImportFile">
      </div>
    </div>

    <div v-if="effective" class="tt-card">
      <div class="tt-card-title">指令文本（{{ effective.name }}）</div>
      <div class="tt-card-sub">
        任务、示例、写作规则、输出格式这类可改写的指令文本。勾选＝参与组装，点「编辑」改正文。
      </div>
      <div
        v-for="mod in textModules"
        :key="mod.id"
        class="tt-prompt-module"
        :class="{ 'tt-prompt-module--disabled': !mod.enabled }"
      >
        <div class="tt-prompt-module-head">
          <label class="tt-prompt-module-toggle" :title="mod.enabled ? '点击停用' : '点击启用'">
            <input type="checkbox" :checked="mod.enabled" @change="prompts.toggleModule(effective.id, mod.id, ($event.target as HTMLInputElement).checked)">
            <span>{{ mod.name }}</span>
          </label>
          <!-- 角色不设下拉：system/user 是消息内部概念，由引擎按默认模板固定。
               旧版（fork）同样不暴露此字段，用户实测无需可调。 -->
          <span class="tt-prompt-module-ops">
            <button type="button" title="上移" :disabled="isFirst(mod)" @click="prompts.moveModule(effective.id, mod.id, -1)">↑</button>
            <button type="button" title="下移" :disabled="isLast(mod)" @click="prompts.moveModule(effective.id, mod.id, 1)">↓</button>
            <button type="button" @click="toggleEdit(mod)">{{ editingId === mod.id ? '收起' : '编辑' }}</button>
          </span>
        </div>
        <textarea
          v-if="editingId === mod.id"
          class="tt-prompt-module-editor"
          :value="mod.content"
          rows="10"
          spellcheck="false"
          @change="prompts.updateModuleContent(effective.id, mod.id, ($event.target as HTMLTextAreaElement).value)"
        />
      </div>
    </div>

    <div class="tt-prompt-section-title">上下文注入</div>
    <div v-if="effective" class="tt-card">
      <div class="tt-card-sub">
        这些开关决定把哪些现场信息带给生成选项的 AI：勾选＝注入，取消＝不带。
      </div>
      <div
        v-for="mod in contextModules"
        :key="mod.id"
        class="tt-prompt-module"
        :class="{ 'tt-prompt-module--disabled': !mod.enabled }"
      >
        <div class="tt-prompt-module-head">
          <label class="tt-prompt-module-toggle" :title="mod.enabled ? '点击停用' : '点击启用'">
            <input type="checkbox" :checked="mod.enabled" @change="prompts.toggleModule(effective.id, mod.id, ($event.target as HTMLInputElement).checked)">
            <span>{{ mod.name }}</span>
          </label>
          <!-- chat_history 的楼层角色由聊天本身决定（user/assistant）；
               其余注入模块角色由引擎固定。UI 不暴露角色概念（旧版同样如此）。 -->
          <span class="tt-prompt-module-ops">
            <button type="button" title="上移" :disabled="isFirst(mod)" @click="prompts.moveModule(effective.id, mod.id, -1)">↑</button>
            <button type="button" title="下移" :disabled="isLast(mod)" @click="prompts.moveModule(effective.id, mod.id, 1)">↓</button>
          </span>
        </div>
        <div class="tt-prompt-module-desc">{{ sourceDescription(mod) }}</div>
      </div>
    </div>

    <div class="tt-prompt-section-title">高级</div>
    <div class="tt-card">
      <div class="tt-card-title">外部插件内容搬运（可选）</div>
      <div class="tt-card-sub">
        勾选后，其他插件（如记忆摘要类）注入到酒馆的内容会被一并带给生成选项的 AI。默认全关。
      </div>
      <label class="tt-prompt-switch">
        <input type="checkbox" :checked="prompts.externalInjections.baibai" @change="prompts.setExternalInjections({ baibai: ($event.target as HTMLInputElement).checked })">
        <span>柏宝书剧情摘要</span>
        <span class="tt-prompt-module-desc">STBaiBaiBook（柏宝书）插件生成的剧情摘要；插件不在场时自动忽略。</span>
      </label>
      <label class="tt-prompt-switch">
        <input type="checkbox" :checked="prompts.externalInjections.allSlots" @change="prompts.setExternalInjections({ allSlots: ($event.target as HTMLInputElement).checked })">
        <span>其他插件注入的内容（全部搬入）</span>
        <span class="tt-prompt-module-desc">记忆/摘要类插件写到酒馆公共注入区的内容，开了就全部带给 AI，不用也不需要逐个挑。</span>
      </label>
      <div class="tt-prompt-slots">
        <div class="tt-card-sub">当前在场：{{ slots.length ? slots.map(s => s.key).join('、') : '无' }}</div>
        <button type="button" class="tt-prompt-refresh" @click="slots = listSlotPreviews()">重新扫描</button>
        <div v-if="!slots.length" class="tt-prompt-empty">没有插件写入槽位——点了「重新扫描」仍为空，说明记忆/摘要类插件未挂载或未写入。</div>
      </div>
      <div v-if="effective" class="tt-prompt-slots">
        <div class="tt-card-sub">对应管线模块（只管位置排序；启停由上面的开关承载，不设第二道门）</div>
        <div
          v-for="mod in externalModules"
          :key="mod.id"
          class="tt-prompt-module"
        >
          <div class="tt-prompt-module-head">
            <span class="tt-prompt-module-name">{{ mod.name }}</span>
            <span class="tt-prompt-module-ops">
              <button type="button" title="上移" :disabled="isFirst(mod)" @click="prompts.moveModule(effective.id, mod.id, -1)">↑</button>
              <button type="button" title="下移" :disabled="isLast(mod)" @click="prompts.moveModule(effective.id, mod.id, 1)">↓</button>
            </span>
          </div>
          <div class="tt-prompt-module-desc">{{ sourceDescription(mod) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { createPromptConfigFromDefault, listSlotPreviews, moduleGroupOf, usePromptsStore, validatePromptModules, type InjectModule, type InjectionSource, type PromptModule, type SlotPreview, type TextModule } from '@/prompts';

const prompts = usePromptsStore();

const editingId = ref('');
const slots = ref<SlotPreview[]>([]);
const importFileInput = ref<HTMLInputElement | null>(null);

const effective = computed(() => prompts.effectiveConfig);
// G5 三分组共用同一条 order 管线：各组按 order 截取子序列呈现
// （filter 谓词收窄到 TextModule/InjectModule——组内模板用得到 kind 字段）
const textModules = computed(() => {
    const cfg = effective.value;
    if (!cfg) return [];
    return [...cfg.modules].sort((a, b) => a.order - b.order).filter((m): m is TextModule => m.kind === 'text');
});
const contextModules = computed(() => {
    const cfg = effective.value;
    if (!cfg) return [];
    return [...cfg.modules].sort((a, b) => a.order - b.order).filter((m): m is InjectModule => moduleGroupOf(m) === 'context_inject');
});
const externalModules = computed(() => {
    const cfg = effective.value;
    if (!cfg) return [];
    return [...cfg.modules].sort((a, b) => a.order - b.order).filter((m): m is InjectModule => moduleGroupOf(m) === 'external_inject');
});

/** 每项注入源的白话说明（G5：说明每项注入什么，替代裸 source 标识）。 */
const SOURCE_DESCRIPTIONS: Record<InjectionSource, string> = {
    persona: '用户人设：宿主「用户人设」面板里当前选中的那套自我描述。',
    char_description: '角色描述：角色卡「描述」栏的形象与背景设定。',
    char_personality: '角色性格：角色卡「性格」栏的性格概要。',
    char_scenario: '故事背景：角色卡「场景」栏自带的开场情境。',
    world_info_before: '世界书：当前激活的条目，注入在聊天历史之前。',
    world_info_after: '世界书：当前激活的条目，注入在聊天历史之后。',
    wi_depth_before: '世界书：按对话深度插入到历史中段的条目。',
    wi_depth_after: '世界书：按对话深度插入到历史后段的条目。',
    chat_history: '聊天历史：最近几轮对话（层数在「选项生成」页设置）；最新一条 AI 回复会标为当前场景。',
    story_direction: '剧情走向：「选项生成」页写的方向文本与已应用预设。',
    external_slot: '其他插件注入到酒馆通用槽位的内容，按上方勾选搬入。',
    baibai: 'STBaiBaiBook（柏宝书）插件生成的剧情摘要。',
};

function sourceDescription(mod: PromptModule): string {
    return mod.kind === 'inject' ? SOURCE_DESCRIPTIONS[mod.source] : '';
}

function groupListOf(mod: PromptModule): PromptModule[] {
    const group = moduleGroupOf(mod);
    if (group === 'text') return textModules.value;
    if (group === 'context_inject') return contextModules.value;
    return externalModules.value;
}

function isFirst(mod: PromptModule): boolean {
    return groupListOf(mod)[0]?.id === mod.id;
}

function isLast(mod: PromptModule): boolean {
    const list = groupListOf(mod);
    return list[list.length - 1]?.id === mod.id;
}

function toggleEdit(mod: PromptModule): void {
    editingId.value = editingId.value === mod.id ? '' : mod.id;
}

function createConfig(): void {
    const name = prompt('新配置名称：');
    if (!name?.trim()) return;
    const base = effective.value ?? createPromptConfigFromDefault(name.trim());
    prompts.createConfig(name.trim(), base);
}

function renameConfig(cfg: { id: string; name: string }): void {
    const name = prompt('配置名称：', cfg.name);
    if (!name?.trim()) return;
    prompts.renameConfig(cfg.id, name.trim());
}

function confirmDelete(cfg: { id: string; name: string }): void {
    if (!confirm(`删除配置「${cfg.name}」？（不可恢复）`)) return;
    prompts.deleteConfig(cfg.id);
}

function exportConfig(cfg: { id: string; name: string; modules: unknown[] }): void {
    const payload = JSON.stringify({ name: cfg.name, modules: cfg.modules }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tt-prompt-config-${cfg.name || cfg.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importConfig(): void {
    importFileInput.value?.click();
}

async function onImportFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
        const text = await file.text();
        let data: { name?: unknown; modules?: unknown };
        try {
            data = JSON.parse(text) as { name?: unknown; modules?: unknown };
        } catch (e) {
            throw new Error(`文件不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
        }
        if (!Array.isArray(data.modules)) throw new Error('JSON 缺少 modules 数组');
        // 导入边界契约校验（Parse, don't validate）：外部文件逐字段过显式
        // 契约，任一不合约整份拒绝（可读错误定位到模块与字段，不部分落盘）
        const validation = validatePromptModules(data.modules);
        if (!validation.ok) throw new Error(`模块契约不符：${validation.error}`);
        const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '导入配置';
        prompts.createConfig(name, { id: '', name, modules: validation.modules });
    } catch (e) {
        alert(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
}

// 挂载时预扫一次槽位；运行期插件动态写入由「重新扫描」按钮重扫
// （宿主槽位表非响应式，无法自动追踪）
onMounted(() => {
    slots.value = listSlotPreviews();
});
</script>

<style>
.tt-prompt-intro {
    font-size: 0.85em;
    opacity: 0.85;
    padding: 0 2px 6px;
}

.tt-prompt-section-title {
    font-size: 0.92em;
    font-weight: bold;
    margin: 10px 2px 4px;
    padding-bottom: 2px;
    border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #666) 55%, transparent);
}

.tt-prompt-config-list {
    list-style: none;
    margin: 0;
    padding: 0;
}

.tt-prompt-config-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 2px;
    border-bottom: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor, #666) 40%, transparent);
}

.tt-prompt-config-row--active .tt-prompt-config-name {
    font-weight: bold;
}

.tt-prompt-config-activate {
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.15));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 8px;
    font-size: 0.78em;
    cursor: pointer;
    flex-shrink: 0;
}

.tt-prompt-config-name {
    font-size: 0.88em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 12em;
}

.tt-prompt-config-count {
    font-size: 0.75em;
    opacity: 0.55;
}

.tt-prompt-config-ops {
    margin-left: auto;
    display: flex;
    gap: 4px;
    flex-shrink: 0;
}

.tt-prompt-config-ops button {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 8px;
    font-size: 0.75em;
    cursor: pointer;
}

.tt-prompt-config-op-danger:hover {
    color: var(--SmartThemeQuoteColor, #c58a36);
}

.tt-prompt-module {
    border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #666) 55%, transparent);
    border-radius: 6px;
    padding: 4px 8px;
    margin-bottom: 4px;
}

.tt-prompt-module--disabled {
    opacity: 0.55;
}

.tt-prompt-module-head {
    display: flex;
    align-items: center;
    gap: 8px;
}

.tt-prompt-module-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
    cursor: pointer;
    min-width: 0;
}

.tt-prompt-module-name {
    font-size: 0.85em;
}

.tt-prompt-module-ops {
    margin-left: auto;
    display: flex;
    gap: 4px;
    flex-shrink: 0;
}

.tt-prompt-module-ops button {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 4px;
    padding: 1px 8px;
    font-size: 0.78em;
    cursor: pointer;
}

.tt-prompt-module-ops button:disabled {
    opacity: 0.35;
    cursor: default;
}

.tt-prompt-module-desc {
    font-size: 0.72em;
    opacity: 0.6;
    margin: 2px 0 0 22px;
}

.tt-prompt-module-editor {
    width: 100%;
    box-sizing: border-box;
    margin-top: 4px;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 4px 6px;
    font-family: monospace;
    font-size: 0.8em;
    resize: vertical;
}

.tt-prompt-switch {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 0.85em;
    cursor: pointer;
}

.tt-prompt-slots {
    margin-top: 6px;
    border-top: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor, #666) 40%, transparent);
    padding-top: 6px;
}

.tt-prompt-refresh {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 10px;
    font-size: 0.78em;
    cursor: pointer;
    margin-bottom: 4px;
}

.tt-prompt-empty {
    font-size: 0.8em;
    opacity: 0.6;
    padding: 4px 0;
}
</style>
