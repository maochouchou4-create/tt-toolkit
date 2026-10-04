<template>
  <!--
    提示词编辑器（方案 §2.3）：配置集管理＋模块列表（启停/排序/编辑）＋
    导入导出＋消息组装 dump＋外部注入搬运配置。
    单一真相源：直接编辑当前生效配置的 modules[]（无工作副本——fork 双
    真相源病不继承）。
  -->
  <div class="tt-prompt-editor-tab">
    <div class="tt-card">
      <div class="tt-card-title">配置集</div>
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
      <div class="tt-card-title">模块管线（{{ effective.name }}）</div>
      <div class="tt-card-sub">
        文本模块与注入模块同一条顺序（order）；勾选＝参与组装。编辑保存即时生效（无快照层）。
      </div>
      <div
        v-for="mod in sortedModules"
        :key="mod.id"
        class="tt-prompt-module"
        :class="{ 'tt-prompt-module--disabled': !mod.enabled }"
      >
        <div class="tt-prompt-module-head">
          <label class="tt-prompt-module-toggle" :title="mod.enabled ? '点击停用' : '点击启用'">
            <input type="checkbox" :checked="mod.enabled" @change="prompts.toggleModule(effective.id, mod.id, ($event.target as HTMLInputElement).checked)">
            <span>{{ mod.name }}</span>
          </label>
          <span class="tt-prompt-module-kind" :title="mod.kind === 'inject' ? `注入源：${mod.source}` : '文本模块'">
            {{ mod.kind === 'inject' ? '注入' : '文本' }}
          </span>
          <select class="tt-prompt-module-role" :value="mod.role" title="消息角色" @change="prompts.updateModuleRole(effective.id, mod.id, ($event.target as HTMLSelectElement).value as PromptModule['role'])">
            <option value="system">system</option>
            <option value="user">user</option>
            <option value="assistant">assistant</option>
          </select>
          <span class="tt-prompt-module-ops">
            <button type="button" title="上移" :disabled="isFirst(mod)" @click="prompts.moveModule(effective.id, mod.id, -1)">↑</button>
            <button type="button" title="下移" :disabled="isLast(mod)" @click="prompts.moveModule(effective.id, mod.id, 1)">↓</button>
            <button v-if="mod.kind === 'text'" type="button" @click="toggleEdit(mod)">{{ editingId === mod.id ? '收起' : '编辑' }}</button>
          </span>
        </div>
        <div v-if="mod.kind === 'inject'" class="tt-prompt-module-source">注入源：{{ mod.source }}{{ mod.source === 'chat_history' ? '（原始楼层角色；末条 AI 楼层自动 <current_scene> 包裹）' : '' }}</div>
        <textarea
          v-if="mod.kind === 'text' && editingId === mod.id"
          class="tt-prompt-module-editor"
          :value="mod.content"
          rows="10"
          spellcheck="false"
          @change="prompts.updateModuleContent(effective.id, mod.id, ($event.target as HTMLTextAreaElement).value)"
        />
      </div>
    </div>

    <div class="tt-card">
      <div class="tt-card-title">外部注入搬运（可选）</div>
      <div class="tt-card-sub">
        独立旁路请求不会自动继承酒馆与其他插件的注入——需要的外部内容在此勾选搬入。默认全关。
      </div>
      <label class="tt-prompt-switch">
        <input type="checkbox" :checked="prompts.externalInjections.baibai" @change="prompts.setExternalInjections({ baibai: ($event.target as HTMLInputElement).checked })">
        <span>柏宝书剧情摘要（STBaiBaiBook 插件在场时自动取注入口径）</span>
      </label>
      <div class="tt-prompt-slots">
        <div class="tt-card-sub">宿主通用注入槽位（当前在场：{{ slots.length }} 项）</div>
        <button type="button" class="tt-prompt-refresh" @click="slots = listSlotPreviews()">刷新槽位列表</button>
        <ul v-if="slots.length" class="tt-prompt-slot-list">
          <li v-for="slot in slots" :key="slot.key" class="tt-prompt-slot-row">
            <label class="tt-prompt-module-toggle" :title="slot.preview">
              <input type="checkbox" :checked="prompts.externalInjections.selectedSlots.includes(slot.key)" @change="prompts.toggleSlot(slot.key, ($event.target as HTMLInputElement).checked)">
              <span class="tt-prompt-slot-key">{{ slot.key }}</span>
            </label>
            <span class="tt-prompt-slot-preview" :title="slot.preview">{{ slot.preview }}</span>
          </li>
        </ul>
        <div v-else class="tt-prompt-empty">无占用槽位（记忆/摘要类插件未挂载或未写入）——点刷新重扫</div>
      </div>
    </div>

    <div class="tt-card">
      <div class="tt-card-title">消息组装 dump</div>
      <div class="tt-card-sub">
        用当前宿主数据跑一次完整组装（与实际发送同一管线）——各模块注入与否逐项可见。控制台口：__TTK_PROMPTS__.dump()
      </div>
      <div class="tt-actions">
        <button type="button" :disabled="dumpRunning" @click="runDump">{{ dumpRunning ? '组装中…' : '运行组装' }}</button>
        <button v-if="dumpText" type="button" @click="copyDump">复制</button>
      </div>
      <pre v-if="dumpText" class="tt-dump">{{ dumpText }}</pre>
      <div v-else-if="dumpError" class="tt-prompt-dump-error">{{ dumpError }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { createPromptConfigFromDefault, listSlotPreviews, usePromptsStore, validatePromptModules, type PromptModule, type SlotPreview } from '@/prompts';
import { assembleCurrent } from '@/modules/choice/generator';
import { useChoiceStore } from '@/modules/choice/store';

const prompts = usePromptsStore();
const choiceStore = useChoiceStore();

const editingId = ref('');
const slots = ref<SlotPreview[]>([]);
const dumpText = ref('');
const dumpError = ref('');
const dumpRunning = ref(false);
const importFileInput = ref<HTMLInputElement | null>(null);

const effective = computed(() => prompts.effectiveConfig);
const sortedModules = computed(() => {
    const cfg = effective.value;
    if (!cfg) return [];
    return [...cfg.modules].sort((a, b) => a.order - b.order);
});

function isFirst(mod: PromptModule): boolean {
    return sortedModules.value[0]?.id === mod.id;
}

function isLast(mod: PromptModule): boolean {
    return sortedModules.value[sortedModules.value.length - 1]?.id === mod.id;
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

async function runDump(): Promise<void> {
    dumpRunning.value = true;
    dumpError.value = '';
    try {
        const { dumpText: text } = await assembleCurrent();
        dumpText.value = text;
        choiceStore.lastDump = text;
    } catch (e) {
        dumpError.value = `组装失败：${e instanceof Error ? e.message : String(e)}`;
    } finally {
        dumpRunning.value = false;
    }
}

async function copyDump(): Promise<void> {
    try {
        await navigator.clipboard.writeText(dumpText.value);
    } catch {
        // 剪贴板权限拒绝：无提示降级（内容已在 <pre> 中可手选）
    }
}

// 挂载时预扫一次槽位；运行期插件动态写入由「刷新槽位列表」按钮重扫
// （宿主槽位表非响应式，无法自动追踪）
onMounted(() => {
    slots.value = listSlotPreviews();
});
</script>

<style>
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

.tt-prompt-module-kind {
    font-size: 0.7em;
    opacity: 0.55;
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 4px;
    padding: 0 4px;
    flex-shrink: 0;
}

.tt-prompt-module-role {
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 4px;
    font-size: 0.75em;
    flex-shrink: 0;
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

.tt-prompt-module-source {
    font-size: 0.72em;
    opacity: 0.55;
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

.tt-prompt-slot-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 180px;
    overflow-y: auto;
}

.tt-prompt-slot-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    font-size: 0.8em;
}

.tt-prompt-slot-key {
    font-weight: bold;
    flex-shrink: 0;
}

.tt-prompt-slot-preview {
    opacity: 0.55;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tt-prompt-empty {
    font-size: 0.8em;
    opacity: 0.6;
    padding: 4px 0;
}

.tt-prompt-dump-error {
    color: var(--SmartThemeQuoteColor, #c58a36);
    font-size: 0.8em;
}
</style>
