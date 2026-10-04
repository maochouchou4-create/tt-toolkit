<template>
  <!--
    条目池 tab（批C）：池配置绑定＋抽取参数＋条目两层编辑＋数据导入。
    视觉从简：卡片化＋SmartTheme 变量（复用壳的 .tt-card 体系；类名独立
    tt-pool- 前缀——样式块是全局的，与 ChoiceSettingsTab 的 tt-choice- 前缀
    互不干扰）。
  -->
  <div class="tt-pool-tab">
    <!-- a. 池配置卡 -->
    <div class="tt-card">
      <div class="tt-card-title">池配置</div>
      <div class="tt-card-sub">
        生效的池配置决定本聊天用哪些条目；配置里的规则会作为独立段落写进提示词（与模板写作规则分开）。
      </div>
      <label class="tt-pool-field">
        <span>本聊天使用</span>
        <select :value="pool.chatPoolConfigId" @change="onChatBindingChange">
          <option value="">默认（{{ defaultConfigName }}）</option>
          <option v-for="c in pool.poolConfigs" :key="c.id" :value="c.id">{{ c.name }}{{ c.isDefault ? '（默认）' : '' }}</option>
        </select>
      </label>
      <div class="tt-pool-note">
        当前生效：{{ pool.effectiveConfig ? pool.effectiveConfig.name : '无配置（整个池参与抽取）' }}
      </div>

      <template v-if="pool.effectiveConfig">
        <label class="tt-pool-field tt-pool-field--block">
          <span>配置规则（可选）</span>
          <textarea v-model="rulesText" rows="4" placeholder="这套池配置的写作规则，如反 OOC 约束……（留空则不注入）" />
        </label>
        <div class="tt-pool-note">规则原文注入提示词的「池规则」段；逐条目的小规则写在条目自己的「规则」字段里。</div>
      </template>
      <div v-else class="tt-pool-empty">还没有池配置——点「新建配置」创建（或直接导入旧版数据）。</div>

      <div class="tt-actions">
        <button type="button" @click="newConfig">新建配置</button>
        <button type="button" :disabled="!pool.effectiveConfig" @click="duplicateConfig">复制当前</button>
        <button type="button" :disabled="!pool.effectiveConfig || !pool.effectiveConfig.isDefault" @click="markDefault" title="把当前配置设为绑定级联的默认落点">设为默认</button>
        <button type="button" class="tt-pool-op-danger" :disabled="!pool.effectiveConfig" @click="removeConfig">删除</button>
      </div>
    </div>

    <!-- b. 抽取参数卡 -->
    <div class="tt-card">
      <div class="tt-card-title">抽取参数</div>
      <div class="tt-card-sub">每次生成时怎么从池里挑条目（全局参数，所有聊天共用）。</div>
      <label class="tt-pool-field">
        <span>候选超额抽取</span>
        <input :value="pool.poolGen.oversamplePct" type="number" min="0" max="300" step="10" @change="onOversampleChange">
      </label>
      <div class="tt-pool-note">菜单模式：多抽一批候选交给 AI 按当前场景挑选。100% ≈ 候选翻倍，0% ＝刚好抽够。</div>
      <label class="tt-pool-switch">
        <input :checked="pool.poolGen.categoriesEnabled" type="checkbox" @change="onCategoriesToggle">
        <span>按分类轮询（保证各分类都有机会出现）</span>
      </label>
      <label class="tt-pool-field">
        <span>固定条目超发</span>
        <select :value="pool.poolGen.pinnedOverflow" @change="onOverflowChange">
          <option value="send_all">全部发送（默认）</option>
          <option value="trim">截到目标条数</option>
        </select>
      </label>
      <div class="tt-pool-note">固定（pinned）条目总数超过「选项条数」时：全部发送或打乱后截断。</div>
      <label class="tt-pool-switch">
        <input :checked="pool.poolGen.shuffleFinal" type="checkbox" @change="onShuffleToggle">
        <span>发送前打乱顺序（固定区与候选区分别打乱）</span>
      </label>
      <label class="tt-pool-switch">
        <input :checked="pool.poolGen.autoGenerate" type="checkbox" @change="onAutoToggle">
        <span>AI 回复后自动生成选项（生成中 / 未配 API 自动跳过）</span>
      </label>
    </div>

    <!-- c. 条目列表卡 -->
    <div class="tt-card">
      <div class="tt-card-title">条目列表</div>
      <div class="tt-card-sub">
        内容（标题 / 正文 / 规则 / 分类 / 权重）属于整个池；「本配置」一栏只对当前生效的池配置生效。
      </div>
      <label class="tt-pool-field">
        <span>搜索</span>
        <input v-model="searchText" type="text" placeholder="标题 / 正文 / 规则 / 分类，全量搜索">
      </label>
      <div class="tt-actions">
        <button type="button" @click="newEntry">新增条目</button>
      </div>

      <div v-if="!groupedEntries.length" class="tt-pool-empty">
        {{ pool.masterPool.length ? '没有匹配搜索的条目。' : '池还是空的——点「新增条目」或去「数据导入」搬入旧版数据。' }}
      </div>

      <div v-for="group in groupedEntries" :key="group.category" class="tt-pool-group">
        <div class="tt-pool-group-head">{{ group.category }}<span class="tt-pool-group-count">{{ group.entries.length }}</span></div>
        <div v-for="entry in group.entries" :key="entry.id">
          <div class="tt-pool-entry-row" @click="toggleExpand(entry)">
            <span class="tt-pool-entry-type">{{ entry.type || '（无标题）' }}</span>
            <span class="tt-pool-entry-content">{{ entry.content }}</span>
            <span class="tt-pool-entry-badges">
              <span v-if="entryBadge(entry)" class="tt-pool-badge">{{ entryBadge(entry) }}</span>
            </span>
          </div>

          <div v-if="expandedId === entry.id" class="tt-pool-entry-editor">
            <div class="tt-pool-editor-title">池内容（全池共用）</div>
            <label class="tt-pool-field">
              <span>标题</span>
              <input v-if="entryDraft" v-model.trim="entryDraft.type" type="text" placeholder="选项的标题前缀">
            </label>
            <label class="tt-pool-field tt-pool-field--block">
              <span>正文</span>
              <textarea v-if="entryDraft" v-model="entryDraft.content" rows="3" placeholder="交给 AI 的候选素材" />
            </label>
            <label class="tt-pool-field tt-pool-field--block">
              <span>规则（可选）</span>
              <textarea v-if="entryDraft" v-model="entryDraft.rule" rows="2" placeholder="只约束这条选项怎么写" />
            </label>
            <label class="tt-pool-field">
              <span>分类</span>
              <input v-if="entryDraft" v-model.trim="entryDraft.category" type="text" placeholder="分类（分组轮询的桶）">
            </label>
            <label class="tt-pool-field">
              <span>池层权重</span>
              <input v-if="entryDraft" :value="entryDraft.weight" type="number" min="1" max="50" step="0.5" @change="onDraftWeightChange">
            </label>
            <div class="tt-actions">
              <button type="button" @click="saveDraft">保存池内容</button>
              <button type="button" class="tt-pool-op-danger" @click="deleteEntry(entry)">删除条目</button>
            </div>

            <div class="tt-pool-editor-title">本配置（{{ pool.effectiveConfig ? pool.effectiveConfig.name : '无配置' }}）</div>
            <template v-if="refOf(entry.id)">
              <label class="tt-pool-switch">
                <input :checked="refOf(entry.id)!.enabled" type="checkbox" @change="onRefEnabledToggle(entry)">
                <span>参与抽取（停用后本配置不抽它）</span>
              </label>
              <label class="tt-pool-switch">
                <input :checked="refOf(entry.id)!.pinned" type="checkbox" @change="onRefPinnedToggle(entry)">
                <span>固定必发（pinned，不参与抽签）</span>
              </label>
              <label class="tt-pool-field">
                <span>本配置权重</span>
                <input :value="refOf(entry.id)!.weight" type="number" min="1" max="50" step="0.5" @change="onRefWeightChange($event, entry)">
              </label>
              <div class="tt-actions">
                <button type="button" class="tt-pool-op-danger" @click="removeRef(entry)">移出本配置</button>
              </div>
            </template>
            <template v-else>
              <div class="tt-pool-empty">这条还没被当前配置引用（不参与本配置的抽取）。</div>
              <div class="tt-actions">
                <button type="button" :disabled="!pool.effectiveConfig" @click="addRef(entry)">加入本配置</button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- d. 导入卡 -->
    <div class="tt-card">
      <div class="tt-card-title">数据导入与备份</div>
      <div class="tt-card-sub">把旧版 choice 插件的数据一键搬进来；或导出 / 导入本仓格式做自备份。</div>
      <div class="tt-actions">
        <button type="button" :disabled="!pool.legacyAvailable" @click="runLegacyImport">导入旧版数据</button>
      </div>
      <div v-if="!pool.legacyAvailable" class="tt-pool-note">未检测到旧版数据（需要旧插件在本酒馆运行过一次才会留下 extension_settings.choice）。</div>
      <div v-if="legacyReport" class="tt-pool-report">
        <div>导入完成：池条目 {{ legacyReport.masterPoolImported }} 条（跳过 {{ legacyReport.masterPoolSkipped }}）· 池配置 {{ legacyReport.configsImported }} 套（跳过 {{ legacyReport.configsSkipped }}）· API {{ legacyReport.apisImported }} 个（跳过 {{ legacyReport.apisSkipped }}）</div>
        <div v-if="legacyReport.ignoredFields.length" class="tt-pool-report-ignored">
          <div>已忽略字段（未平移）：</div>
          <ul>
            <li v-for="field in legacyReport.ignoredFields" :key="field">{{ field }}</li>
          </ul>
        </div>
        <div v-if="legacyReport.notes.length" class="tt-pool-report-notes">
          <div>提示：</div>
          <ul>
            <li v-for="note in legacyReport.notes" :key="note">{{ note }}</li>
          </ul>
        </div>
      </div>

      <div class="tt-actions">
        <button type="button" @click="exportBackup">导出备份 JSON</button>
        <label class="tt-pool-import-file">
          导入备份 JSON
          <input type="file" accept="application/json,.json" @change="onBackupFile">
        </label>
      </div>
      <div v-if="backupError" class="tt-pool-report-error">导入被拒：{{ backupError }}</div>
      <div v-if="backupReport" class="tt-pool-report">
        <div>备份导入完成：池条目 {{ backupReport.masterPoolImported }} 条 · 池配置 {{ backupReport.configsImported }} 套 · API {{ backupReport.apisImported }} 个（已存在的按 id 跳过）</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { usePoolStore } from '@/modules/choice/pool/store';
import type { PoolConfigEntry, PoolEntry } from '@/modules/choice/pool/types';
import type { PoolImportReport } from '@/modules/choice/pool/import';

const pool = usePoolStore();

// ---- a. 池配置卡 ----

const defaultConfigName = computed(() => pool.poolConfigs.find(c => c.isDefault)?.name ?? '未设置');

function onChatBindingChange(e: Event) {
    pool.setChatBinding((e.target as HTMLSelectElement).value);
}

function newConfig() {
    const cfg = pool.newConfig();
    pool.saveConfig(cfg);
    pool.setChatBinding(cfg.id);
}

function duplicateConfig() {
    const base = pool.effectiveConfig;
    if (!base) return;
    const copy = pool.duplicateConfig(base);
    pool.saveConfig(copy);
    pool.setChatBinding(copy.id);
}

function markDefault() {
    const cfg = pool.effectiveConfig;
    if (cfg) pool.markDefault(cfg.id);
}

function removeConfig() {
    const cfg = pool.effectiveConfig;
    if (!cfg) return;
    if (pool.poolConfigs.length <= 1) {
        alert('至少保留一个池配置（绑定级联需要默认落点）');
        return;
    }
    if (!confirm(`删除池配置「${cfg.name}」？其引用关系一并删除（池条目本身保留）。`)) return;
    if (!pool.removeConfig(cfg.id)) alert('删除失败：至少要保留一个配置');
    // chat 绑定悬空＝级联回退默认，语义安全，无需显式清理
}

// 规则编辑：组件内草稿＋防抖 300ms 写穿（避免逐键写盘；照 ChoiceSettingsTab
// 剧情走向的防抖先例）
const rulesText = ref('');
let rulesTimer: ReturnType<typeof setTimeout> | null = null;
let rulesOwner = '';

watch(
    () => pool.effectiveConfig?.id ?? '',
    id => {
        rulesOwner = id;
        rulesText.value = pool.effectiveConfig?.rules ?? '';
    },
    { immediate: true },
);

watch(rulesText, text => {
    if (!rulesOwner) return;
    if (rulesTimer) clearTimeout(rulesTimer);
    rulesTimer = setTimeout(() => {
        const cfg = pool.effectiveConfig;
        // 配置已被删除/切换就不写（防写错对象）
        if (cfg && cfg.id === rulesOwner && cfg.rules !== text) {
            pool.saveConfig({ ...cfg, rules: text });
        }
    }, 300);
});

onBeforeUnmount(() => {
    // 卸载时防抖器不得再触发写穿（切聊天后落盘会写错对象——nav store 同款纪律）
    if (rulesTimer) clearTimeout(rulesTimer);
});

// ---- b. 抽取参数卡 ----

function clampInt(event: Event, min: number, max: number, fallback: number): number {
    const raw = (event.target as HTMLInputElement).value;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.trunc(n), min), max);
}

function clampNumber(event: Event, min: number, max: number, fallback: number): number {
    const raw = (event.target as HTMLInputElement).value;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
}

function onOversampleChange(e: Event) {
    pool.updatePoolGen({ oversamplePct: clampInt(e, 0, 300, 100) });
}

function onCategoriesToggle(e: Event) {
    pool.updatePoolGen({ categoriesEnabled: (e.target as HTMLInputElement).checked });
}

function onOverflowChange(e: Event) {
    pool.updatePoolGen({ pinnedOverflow: (e.target as HTMLSelectElement).value as 'send_all' | 'trim' });
}

function onShuffleToggle(e: Event) {
    pool.updatePoolGen({ shuffleFinal: (e.target as HTMLInputElement).checked });
}

function onAutoToggle(e: Event) {
    pool.updatePoolGen({ autoGenerate: (e.target as HTMLInputElement).checked });
}

// ---- c. 条目列表卡 ----

const searchText = ref('');
const expandedId = ref('');
const entryDraft = ref<PoolEntry | null>(null);

const groupedEntries = computed(() => {
    const q = searchText.value.trim().toLowerCase();
    const list = q
        ? pool.masterPool.filter(e =>
            e.type.toLowerCase().includes(q) ||
            e.content.toLowerCase().includes(q) ||
            e.rule.toLowerCase().includes(q) ||
            e.category.toLowerCase().includes(q))
        : pool.masterPool;
    const groups = new Map<string, PoolEntry[]>();
    for (const entry of list) {
        const key = entry.category.trim() || '未分类';
        const bucket = groups.get(key);
        if (bucket) bucket.push(entry);
        else groups.set(key, [entry]);
    }
    return [...groups.entries()].map(([category, entries]) => ({ category, entries }));
});

function refOf(entryId: string): PoolConfigEntry | null {
    return pool.effectiveConfig?.entries.find(r => r.entryId === entryId) ?? null;
}

/** 行尾徽标（一个条目只挂一个最要紧的身份，避免堆字）。 */
function entryBadge(entry: PoolEntry): string {
    const ref = refOf(entry.id);
    if (!ref) return '未引用';
    if (ref.pinned) return '必发';
    if (!ref.enabled) return '已停用';
    return '';
}

function toggleExpand(entry: PoolEntry) {
    if (expandedId.value === entry.id) {
        expandedId.value = '';
        entryDraft.value = null;
        return;
    }
    expandedId.value = entry.id;
    entryDraft.value = { ...entry };
}

function onDraftWeightChange(e: Event) {
    if (!entryDraft.value) return;
    // 权重下限 1（双复核 P3：UI 不再产生 0 权——0/负在 resolver 是「实质
    // 禁用」的近零权，想让条目不参与用「参与抽取」开关，不是权重 0）
    entryDraft.value.weight = clampNumber(e, 1, 50, 1);
}

function saveDraft() {
    if (!entryDraft.value) return;
    pool.saveEntry(entryDraft.value);
    // 保持展开——继续编辑或调引用层
}

function deleteEntry(entry: PoolEntry) {
    const label = entry.type || entry.content.slice(0, 20) || entry.id;
    if (!confirm(`删除条目「${label}」？各池配置对它的引用会一并清除。`)) return;
    pool.removeEntry(entry.id);
    if (expandedId.value === entry.id) {
        expandedId.value = '';
        entryDraft.value = null;
    }
}

function newEntry() {
    const entry = pool.newEntry();
    pool.saveEntry(entry);
    // 直接进入编辑态（空标题无意义，需要立即填内容）
    searchText.value = '';
    expandedId.value = entry.id;
    entryDraft.value = { ...entry };
}

// 引用层（当前生效配置）：单控件操作，立即写穿
function addRef(entry: PoolEntry) {
    const cfg = pool.effectiveConfig;
    if (!cfg) return;
    const entries = [...cfg.entries, { entryId: entry.id, enabled: true, pinned: entry.pinned, weight: entry.weight }];
    pool.saveConfig({ ...cfg, entries });
}

function patchRef(entry: PoolEntry, patch: Partial<PoolConfigEntry>) {
    const cfg = pool.effectiveConfig;
    if (!cfg) return;
    const entries = cfg.entries.map(r => (r.entryId === entry.id ? { ...r, ...patch } : r));
    pool.saveConfig({ ...cfg, entries });
}

function onRefEnabledToggle(entry: PoolEntry) {
    const ref = refOf(entry.id);
    if (ref) patchRef(entry, { enabled: !ref.enabled });
}

function onRefPinnedToggle(entry: PoolEntry) {
    const ref = refOf(entry.id);
    if (ref) patchRef(entry, { pinned: !ref.pinned });
}

function onRefWeightChange(e: Event, entry: PoolEntry) {
    patchRef(entry, { weight: clampNumber(e, 1, 50, 1) });
}

function removeRef(entry: PoolEntry) {
    const cfg = pool.effectiveConfig;
    if (!cfg) return;
    pool.saveConfig({ ...cfg, entries: cfg.entries.filter(r => r.entryId !== entry.id) });
}

// ---- d. 导入卡 ----

const legacyReport = ref<PoolImportReport | null>(null);
const backupError = ref('');
const backupReport = ref<PoolImportReport | null>(null);

function runLegacyImport() {
    const report = pool.importLegacy();
    if (!report) {
        alert('未发现旧版数据（extension_settings.choice）');
        return;
    }
    legacyReport.value = report;
}

function exportBackup() {
    const blob = new Blob([pool.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'tt-toolkit-pool-backup.json';
    link.click();
    URL.revokeObjectURL(url);
}

function onBackupFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    backupError.value = '';
    backupReport.value = null;
    const reader = new FileReader();
    reader.onload = () => {
        const result = pool.importJson(String(reader.result ?? ''));
        if (!result.ok) {
            backupError.value = result.error;
            return;
        }
        backupReport.value = result.report;
    };
    reader.readAsText(file);
    // 清 value 允许连续选择同一文件
    input.value = '';
}
</script>

<style>
/* 条目池 tab（全局样式块，类名 tt-pool- 前缀与 tt-choice- 互不干扰；
   卡片壳复用壳层 .tt-card 体系） */
.tt-pool-tab {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.tt-pool-field {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 0.85em;
}

.tt-pool-field > span {
    min-width: 9em;
    opacity: 0.8;
    flex-shrink: 0;
}

.tt-pool-field--block {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
}

.tt-pool-field input,
.tt-pool-field select,
.tt-pool-field textarea {
    flex: 1;
    min-width: 0;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 3px 6px;
    font-size: 0.95em;
}

.tt-pool-field textarea {
    resize: vertical;
    font-family: inherit;
}

.tt-pool-switch {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 0.85em;
    cursor: pointer;
}

.tt-pool-note {
    font-size: 0.75em;
    opacity: 0.6;
    padding: 0 0 4px;
}

.tt-pool-empty {
    font-size: 0.8em;
    opacity: 0.6;
    padding: 6px 0;
}

.tt-pool-op-danger:hover {
    color: var(--SmartThemeQuoteColor, #c58a36);
}

.tt-pool-group {
    margin-top: 6px;
}

.tt-pool-group-head {
    font-size: 0.8em;
    font-weight: bold;
    opacity: 0.85;
    padding: 4px 0 2px;
    border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #666) 60%, transparent);
    display: flex;
    align-items: baseline;
    gap: 6px;
}

.tt-pool-group-count {
    font-weight: normal;
    font-size: 0.85em;
    opacity: 0.6;
}

.tt-pool-entry-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 2px;
    cursor: pointer;
    border-bottom: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor, #666) 35%, transparent);
    min-width: 0;
}

.tt-pool-entry-row:hover {
    background: color-mix(in srgb, var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.2)) 60%, transparent);
}

.tt-pool-entry-type {
    font-weight: bold;
    font-size: 0.85em;
    white-space: nowrap;
    flex-shrink: 0;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
}

.tt-pool-entry-content {
    font-size: 0.8em;
    opacity: 0.75;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
}

.tt-pool-entry-badges {
    flex-shrink: 0;
}

.tt-pool-badge {
    font-size: 0.7em;
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 999px;
    padding: 1px 8px;
    opacity: 0.75;
    white-space: nowrap;
}

.tt-pool-entry-editor {
    border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #666) 50%, transparent);
    border-radius: 6px;
    padding: 8px;
    margin: 4px 0 8px;
    background: color-mix(in srgb, var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.15)) 50%, transparent);
}

.tt-pool-editor-title {
    font-size: 0.78em;
    font-weight: bold;
    opacity: 0.8;
    margin: 4px 0;
}

.tt-pool-import-file {
    display: inline-flex;
    align-items: center;
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 10px;
    font-size: 0.85em;
    cursor: pointer;
}

.tt-pool-import-file input {
    display: none;
}

.tt-pool-report {
    font-size: 0.8em;
    margin-top: 6px;
    padding: 6px 8px;
    border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #666) 40%, transparent);
    border-radius: 6px;
}

.tt-pool-report ul {
    margin: 2px 0 0;
    padding-left: 1.4em;
}

.tt-pool-report-ignored,
.tt-pool-report-notes {
    opacity: 0.7;
    margin-top: 4px;
}

.tt-pool-report-error {
    font-size: 0.8em;
    margin-top: 6px;
    color: var(--SmartThemeQuoteColor, #c58a36);
}
</style>
