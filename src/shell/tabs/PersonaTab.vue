<template>
  <!--
    PersonaWeaver fork「人设」tab（批D 平移，整合轮II 收敛）。
    四分区收敛为三：人设/参考/生成通道。
    生成通道＝统一端点表引用＋persona 任务参数（整合轮II：端点身份在「API」页维护）；
    旧「提示词对照」分区删除（模板进「提示词」tab 四任务体系可编辑）。
    视觉从简：卡片化＋SmartTheme 变量（复用壳的 .tt-card 体系），类名前缀 tt-persona-。
  -->
  <div class="tt-persona-tab">
    <!-- 内分区条（人设/参考/生成通道） -->
    <div class="tt-persona-strip">
      <button
        v-for="sec in sections"
        :key="sec.id"
        type="button"
        class="tt-persona-strip-btn"
        :class="{ 'tt-persona-strip-btn--active': activeSection === sec.id }"
        @click="activeSection = sec.id"
      >{{ sec.label }}</button>
    </div>

    <!-- ================= 分区一：人设 ================= -->
    <div v-show="activeSection === 'editor'" class="tt-persona-section">
      <div class="tt-card">
        <div class="tt-card-title">人设编织</div>
        <div class="tt-card-sub">两段 AI 生成人设 YAML → 划词润色 → diff 取舍 → 写回宿主人设或世界书</div>

        <!-- 需求框（有结果时折叠，旧语义） -->
        <details :open="!store.hasResult" class="tt-persona-details">
          <summary>生成需求</summary>
          <textarea
            v-model="store.requestText"
            class="tt-persona-area"
            rows="4"
            placeholder="想要一个什么样的人设？例如：温和的图书管理员，暗中收藏禁忌典籍……"
          />
        </details>

        <div class="tt-actions">
          <button type="button" :disabled="store.isProcessing" @click="store.generate()">
            {{ store.isProcessing ? (store.processingLabel || '处理中…') : '生成人设' }}
          </button>
          <button v-if="store.hasResult" type="button" :disabled="store.isProcessing" @click="store.reroll()">重 roll</button>
          <button v-if="store.hasResult" type="button" @click="confirmClear">清空</button>
        </div>

        <!-- 结果框 + 划词润色（selectionStart/End 事件直挂，砍旧 100ms 防抖） -->
        <textarea
          v-show="!store.showDiff"
          ref="resultArea"
          v-model="store.resultText"
          class="tt-persona-area tt-persona-area--result"
          rows="12"
          placeholder="生成结果（YAML）……"
          @mouseup="captureSelection"
          @select="captureSelection"
          @keyup="captureSelection"
        />
        <div v-if="selectionText" class="tt-persona-selection-hint">
          已选中「{{ selectionText.slice(0, 24) }}{{ selectionText.length > 24 ? '…' : '' }}」
          <button type="button" @click="appendSelection">加入润色意见</button>
        </div>

        <!-- diff 取舍视图 -->
        <div v-if="store.showDiff" class="tt-persona-diff">
          <div class="tt-card-title">润色差异取舍（点选每块采纳侧）</div>
          <div v-for="(block, i) in store.diffBlocks" :key="i" class="tt-persona-diff-block">
            <template v-if="block.type === 'equal'">
              <div class="tt-persona-diff-equal">{{ block.value }}</div>
            </template>
            <template v-else>
              <div class="tt-persona-diff-pair">
                <button
                  type="button"
                  class="tt-persona-diff-side"
                  :class="{ 'tt-persona-diff-side--active': block.active === 'old' }"
                  title="保留原文"
                  @click="store.setBlockActive(i, 'old')"
                >{{ block.oldText }}</button>
                <button
                  type="button"
                  class="tt-persona-diff-side"
                  :class="{ 'tt-persona-diff-side--active': block.active === 'new' }"
                  title="采纳润色"
                  @click="store.setBlockActive(i, 'new')"
                >{{ block.newText }}</button>
              </div>
            </template>
          </div>
          <div class="tt-actions">
            <button type="button" @click="store.confirmDiff()">确认取舍</button>
            <button type="button" @click="store.showDiff = false">取消</button>
          </div>
        </div>

        <!-- 润色意见框 -->
        <div v-if="store.hasResult" class="tt-persona-refine">
          <textarea
            v-model="store.refineText"
            class="tt-persona-area"
            rows="3"
            placeholder="润色意见（划词后可一键加入「对 … 的修改意见为：」）……"
          />
          <div class="tt-actions">
            <button type="button" :disabled="store.isProcessing" @click="store.refine()">
              {{ store.isProcessing ? (store.processingLabel || '处理中…') : '润色' }}
            </button>
          </div>
        </div>
      </div>

      <div class="tt-card">
        <div class="tt-card-title">落库与载入</div>
        <div class="tt-actions">
          <button type="button" :disabled="!store.hasResult" @click="store.saveToPersona()">覆盖当前人设</button>
          <button type="button" :disabled="!store.hasResult" @click="store.saveToWorldInfo()">保存至世界书</button>
        </div>
        <div class="tt-persona-load-row">
          <button type="button" @click="store.loadCurrentPersona()">载入当前人设</button>
          <select v-model="loadCandidateKey" class="tt-persona-load-select">
            <option value="">载入世界书条目…</option>
            <option v-for="(c, i) in store.loadCandidates" :key="i" :value="String(i)">
              {{ c.book }} / {{ c.entry.displayName }}
            </option>
          </select>
          <button type="button" :disabled="loadCandidateKey === ''" @click="confirmLoadEntry">载入条目</button>
        </div>
      </div>
    </div>

    <!-- ================= 分区二：参考 ================= -->
    <div v-show="activeSection === 'context'" class="tt-persona-section">
      <div class="tt-card">
        <div class="tt-card-title">生成预设</div>
        <div class="tt-card-sub">{{ store.presetHint }}</div>
        <!-- :value 绑定（消旧 option[value=模板串] 注入/失配风险） -->
        <select :value="store.generationPreset" class="tt-persona-select" @change="onPresetChange">
          <option v-for="opt in store.presetOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </div>

      <div class="tt-card">
        <div class="tt-card-title">开场白</div>
        <div class="tt-card-sub">注入哪一条开场白作为生成参考</div>
        <select :value="store.selectedGreetingIndex === null ? '' : String(store.selectedGreetingIndex)" class="tt-persona-select" @change="onGreetingChange">
          <option value="">不注入开场白</option>
          <option v-for="(g, i) in store.greetings" :key="i" :value="String(i)">{{ g.label }}</option>
        </select>
      </div>

      <div class="tt-card">
        <div class="tt-card-title">世界书</div>
        <div class="tt-card-sub">勾选注入的条目；钉选的书常驻上下文（≤20 本）</div>
        <div v-for="book in store.availableBooks" :key="book" class="tt-persona-book">
          <div class="tt-persona-book-head">
            <button type="button" class="tt-persona-book-toggle" @click="toggleBookEntries(book)">
              {{ expandedBooks.has(book) ? '▾' : '▸' }} {{ book }}
            </button>
            <button
              type="button"
              class="tt-persona-book-pin"
              :class="{ 'tt-persona-book-pin--on': store.config.extraBooks.includes(book) }"
              @click="store.togglePin(book)"
            >{{ store.config.extraBooks.includes(book) ? '已钉选' : '钉选' }}</button>
          </div>
          <ul v-if="expandedBooks.has(book)" class="tt-persona-entry-list">
            <li v-for="entry in store.bookEntries[book] ?? []" :key="entry.uid" class="tt-persona-entry">
              <label class="tt-persona-entry-check">
                <input
                  type="checkbox"
                  :checked="store.isBookChecked(book, entry.uid)"
                  @change="onEntryCheck(book, entry.uid, $event)"
                >
                <span>{{ entry.displayName }}</span>
              </label>
              <span class="tt-persona-entry-meta">{{ entry.enabled ? '' : '（条目本身未启用）' }}</span>
            </li>
          </ul>
        </div>
        <div v-if="store.availableBooks.length === 0" class="tt-persona-empty">暂无世界书（宿主未建/未绑定）</div>
      </div>
    </div>

    <!-- ================= 分区三：生成通道（整合轮II：统一端点表引用＋persona 任务参数） ================= -->
    <div v-show="activeSection === 'api'" class="tt-persona-section">
      <div class="tt-card">
        <div class="tt-card-title">生成通道</div>
        <div class="tt-card-sub">
          人设生成使用「API」页统一维护的端点；此处只选端点与调人设任务参数。
          提示词模板在「提示词」tab 的「人设」任务里编辑。
        </div>

        <label v-if="apis.endpoints.length" class="tt-persona-field">
          <span>生成端点</span>
          <select :value="store.config.endpointId" class="tt-persona-select" @change="onEndpointChange">
            <option value="">（选择端点）</option>
            <option v-for="e in apis.endpoints" :key="e.id" :value="e.id">{{ e.name || '（未命名）' }} · {{ e.model || '未填模型' }}</option>
          </select>
        </label>
        <div v-else class="tt-persona-empty">
          未配置端点——<button type="button" class="tt-persona-link" @click="goApi">到「API」页添加</button>
        </div>

        <label class="tt-persona-field">
          <span>请求超时（秒）</span>
          <input :value="store.config.timeoutSec" type="number" min="30" max="1800" step="10" @change="onTimeoutChange">
        </label>
        <label class="tt-persona-switch">
          <input :checked="store.config.stream" type="checkbox" @change="onStreamToggle">
          <span>流式输出（假流式端点必开；长请求防挂死）</span>
        </label>
        <label class="tt-persona-field">
          <span>思考强度</span>
          <select :value="store.config.thinkingEffort" class="tt-persona-select" @change="onEffortChange">
            <option value="off">不发送（默认）</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </label>
        <div class="tt-persona-note">思考强度：仅部分端点支持，发错档会被端点忽略或报错，默认不发</div>

        <div class="tt-actions">
          <button type="button" :disabled="store.config.endpointId === ''" @click="store.runTestConnection()">测试连接</button>
        </div>
        <div v-if="store.connectionStatus" class="tt-persona-conn">{{ store.connectionStatus }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref } from 'vue';
import { usePersonaStore } from '@/modules/persona/store';
import { useApisStore } from '@/modules/apis/store';
import { useShellStore } from '@/shell/store';

const store = usePersonaStore();
const apis = useApisStore();
const shell = useShellStore();

/** 内分区条状态（人设/参考/生成通道）。 */
const sections = [
    { id: 'editor', label: '人设' },
    { id: 'context', label: '参考' },
    { id: 'api', label: '生成通道' },
] as const;
const activeSection = ref<(typeof sections)[number]['id']>('editor');

/** 参考分区已展开的书目集合。 */
const expandedBooks = reactive(new Set<string>());

/** 载入世界书条目的下拉选择值（索引字符串）。 */
const loadCandidateKey = ref('');

/** 划词润色：结果框当前选中文本（事件直挂，砍旧 100ms 防抖）。 */
const selectionText = ref('');
const resultArea = ref<HTMLTextAreaElement | null>(null);

function captureSelection(): void {
    const area = resultArea.value;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    selectionText.value = start !== end ? area.value.slice(start, end) : '';
}

function appendSelection(): void {
    if (selectionText.value) store.appendRefineSelection(selectionText.value);
    selectionText.value = '';
}

function confirmClear(): void {
    if (!confirm('清空需求/结果/润色现场？（已落库的配置不受影响）')) return;
    store.clearAll();
}

const selectedLoadCandidate = computed(() => {
    const idx = Number(loadCandidateKey.value);
    return Number.isInteger(idx) && idx >= 0 ? store.loadCandidates[idx] ?? null : null;
});

function confirmLoadEntry(): void {
    const candidate = selectedLoadCandidate.value;
    if (!candidate) return;
    if (!confirm(`载入「${candidate.book} / ${candidate.entry.displayName}」进结果框（覆盖现有内容）？`)) return;
    store.loadWorldBookEntry(candidate.book, candidate.entry.uid);
    loadCandidateKey.value = '';
}

function onPresetChange(event: Event): void {
    store.selectPreset((event.target as HTMLSelectElement).value);
}

function onGreetingChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    store.selectGreeting(value === '' ? null : Number(value));
}

function toggleBookEntries(book: string): void {
    if (expandedBooks.has(book)) expandedBooks.delete(book);
    else {
        expandedBooks.add(book);
        void store.ensureBookEntries(book);
    }
}

function onEntryCheck(book: string, uid: number, event: Event): void {
    store.setCheck(book, uid, (event.target as HTMLInputElement).checked);
}

/** 生成通道：端点选择写穿（setEndpointId 内部即时落域）。 */
function onEndpointChange(event: Event): void {
    store.setEndpointId((event.target as HTMLSelectElement).value);
}

function onTimeoutChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) store.config.timeoutSec = Math.max(30, Math.min(1800, Math.round(value)));
    store.saveConfig();
}

function onStreamToggle(event: Event): void {
    store.config.stream = (event.target as HTMLInputElement).checked;
    store.saveConfig();
}

function onEffortChange(event: Event): void {
    store.config.thinkingEffort = (event.target as HTMLSelectElement).value as 'off' | 'low' | 'medium' | 'high';
    store.saveConfig();
}

function goApi(): void {
    shell.activate('api');
}

/** onActivate 快照纪律：宿主派生数据每次激活刷新（只读宿主，不写域）。 */
onMounted(() => { store.refreshHostData(); });
onActivated(() => { store.refreshHostData(); });
</script>

<style>
/* 人设 tab 自持样式（tt-persona- 前缀；卡片壳复用壳层 .tt-card 体系） */
.tt-persona-strip {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-bottom: 8px;
}

.tt-persona-strip-btn {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 3px 10px;
    font-size: 0.82em;
    cursor: pointer;
}

.tt-persona-strip-btn--active {
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.2));
    font-weight: bold;
}

.tt-persona-area {
    width: 100%;
    box-sizing: border-box;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 6px 8px;
    font-family: var(--monospaceFontFamily, monospace);
    font-size: 0.85em;
    resize: vertical;
}

.tt-persona-area--result {
    min-height: 12em;
}

.tt-persona-details {
    margin: 4px 0;
}

.tt-persona-details summary {
    cursor: pointer;
    font-size: 0.85em;
    opacity: 0.8;
    padding: 2px 0;
}

.tt-persona-details[open] > summary {
    margin-bottom: 4px;
}

.tt-persona-selection-hint {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.78em;
    opacity: 0.85;
    padding: 3px 0;
}

.tt-persona-selection-hint button {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 1px 8px;
    font-size: 0.95em;
    cursor: pointer;
}

.tt-persona-refine {
    margin-top: 8px;
    border-top: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor, #666) 40%, transparent);
    padding-top: 8px;
}

.tt-persona-diff {
    margin: 8px 0;
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 8px;
    max-height: 28em;
    overflow-y: auto;
}

.tt-persona-diff-block {
    margin: 2px 0;
}

.tt-persona-diff-equal {
    font-family: var(--monospaceFontFamily, monospace);
    font-size: 0.8em;
    opacity: 0.6;
    white-space: pre-wrap;
    word-break: break-all;
}

.tt-persona-diff-pair {
    display: flex;
    gap: 6px;
}

.tt-persona-diff-side {
    flex: 1;
    min-width: 0;
    text-align: left;
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px dashed var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 4px 6px;
    font-family: var(--monospaceFontFamily, monospace);
    font-size: 0.8em;
    white-space: pre-wrap;
    word-break: break-all;
    cursor: pointer;
    opacity: 0.55;
}

.tt-persona-diff-side--active {
    opacity: 1;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.18));
    border-style: solid;
}

.tt-persona-load-row {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 6px;
}

.tt-persona-load-select {
    flex: 1;
    min-width: 12em;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 3px 6px;
}

.tt-persona-load-row button,
.tt-persona-book-pin {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 8px;
    font-size: 0.78em;
    cursor: pointer;
}

.tt-persona-select {
    width: 100%;
    box-sizing: border-box;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 3px 6px;
}

.tt-persona-book {
    padding: 4px 0;
    border-bottom: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor, #666) 40%, transparent);
}

.tt-persona-book-head {
    display: flex;
    align-items: center;
    gap: 8px;
}

.tt-persona-book-toggle {
    flex: 1;
    min-width: 0;
    text-align: left;
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: none;
    cursor: pointer;
    font-size: 0.85em;
}

.tt-persona-book-pin--on {
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.2));
    font-weight: bold;
}

.tt-persona-entry-list {
    list-style: none;
    margin: 2px 0;
    padding-left: 14px;
}

.tt-persona-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8em;
    padding: 1px 0;
}

.tt-persona-entry-check {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    min-width: 0;
}

.tt-persona-entry-meta {
    opacity: 0.5;
    font-size: 0.9em;
}

.tt-persona-empty {
    font-size: 0.8em;
    opacity: 0.7;
    padding: 6px 0;
}

.tt-persona-link {
    background: transparent;
    color: var(--SmartThemeQuoteColor, #c58a36);
    border: none;
    padding: 0;
    font-size: 1em;
    cursor: pointer;
    text-decoration: underline;
}

.tt-persona-field {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 0.85em;
}

.tt-persona-field > span {
    min-width: 9em;
    opacity: 0.8;
    flex-shrink: 0;
}

.tt-persona-field input,
.tt-persona-field select {
    flex: 1;
    min-width: 0;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 3px 6px;
    font-size: 0.95em;
}

.tt-persona-switch {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 0.85em;
    cursor: pointer;
}

.tt-persona-note,
.tt-persona-conn {
    font-size: 0.75em;
    opacity: 0.6;
    padding: 2px 0 4px;
}
</style>
