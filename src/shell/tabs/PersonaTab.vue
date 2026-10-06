<template>
  <!--
    「人设」tab（PersonaWeaver 概念的壳内简化形态）。
    单 tab 纵向卡片流：人设编织＋落库与载入两卡；生成参考收 <details>
    折叠块。任务参数（流式/思考强度/超时）已固化为 TASK_DEFAULTS，
    端点选择唯一入口＝「API」页「使用」按钮（未选端点由 generate 的
    fail-fast toast 引导）。生成按钮双态：进行中点击＝取消（choice
    选项条同款长请求逃生姿势）。
    视觉从简：卡片化＋SmartTheme 变量（复用壳的 .tt-card 体系），类名前缀 tt-persona-。
  -->
  <div class="tt-persona-tab">
    <!-- ================= 卡：人设编织 ================= -->
    <div class="tt-card">
      <div class="tt-card-title">人设编织</div>
      <div class="tt-card-sub">两段 AI 生成人设 YAML → 手改 → 写回宿主人设或世界书</div>

      <!-- 需求框（有结果时折叠） -->
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
        <button type="button" @click="onGenerateClick">
          {{ store.isProcessing ? `${store.processingLabel || '处理中…'} · 停止` : '生成人设' }}
        </button>
        <button v-if="store.hasResult" type="button" :disabled="store.isProcessing" @click="store.reroll()">重 roll</button>
        <button v-if="store.hasResult" type="button" @click="confirmClear">清空</button>
      </div>

      <!-- 结果框（可手改；生成/载入/重 roll 共用） -->
      <textarea
        v-model="store.resultText"
        class="tt-persona-area tt-persona-area--result"
        rows="12"
        placeholder="生成结果（YAML）……"
      />
    </div>

    <!-- ================= 卡：落库与载入 ================= -->
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

    <!-- ================= 折叠：生成参考 ================= -->
    <details class="tt-persona-fold">
      <summary>生成参考</summary>
      <div class="tt-card">
        <div class="tt-card-title">开场白</div>
        <div class="tt-card-sub">注入哪一条开场白作为生成参考（默认第一条；「不注入」仅本聊天内保留）</div>
        <select v-if="store.greetings.length > 0" :value="store.selectedGreetingIndex === null ? '' : String(store.selectedGreetingIndex)" class="tt-persona-select" @change="onGreetingChange">
          <option v-for="(g, i) in store.greetings" :key="i" :value="String(i)">{{ g.label }}</option>
          <option value="">不注入开场白</option>
        </select>
        <div v-else class="tt-persona-empty">进入角色会话后可选择开场白</div>
      </div>

      <div class="tt-card">
        <div class="tt-card-title">世界书</div>
        <div v-if="store.boundBooks.length > 0" class="tt-persona-note">已全量注入绑定世界书：{{ store.boundBooks.join('、') }}</div>
        <div v-else class="tt-persona-empty">当前角色未绑定世界书</div>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue';
import { usePersonaStore } from '@/modules/persona/store';

const store = usePersonaStore();

/** 载入世界书条目的下拉选择值（索引字符串）。 */
const loadCandidateKey = ref('');

function confirmClear(): void {
    if (!confirm('清空需求/结果？（已落库的配置不受影响）')) return;
    store.clearAll();
}

/** 生成按钮双态：空闲＝发起生成；进行中＝取消（长请求逃生，choice 选项条同款）。 */
function onGenerateClick(): void {
    if (store.isProcessing) store.cancelGeneration();
    else void store.generate();
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

function onGreetingChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    store.selectGreeting(value === '' ? null : Number(value));
}

/** onActivate 快照纪律：宿主派生数据每次激活刷新（只读宿主，不写域）。 */
onMounted(() => { store.refreshHostData(); });
onActivated(() => { store.refreshHostData(); });
</script>

<style>
/* 人设 tab 自持样式（tt-persona- 前缀；卡片壳复用壳层 .tt-card 体系） */
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

.tt-persona-fold {
    margin: 8px 0;
}

.tt-persona-fold > summary {
    cursor: pointer;
    font-size: 0.9em;
    font-weight: bold;
    padding: 3px 0;
}

.tt-persona-fold[open] > summary {
    margin-bottom: 6px;
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

.tt-persona-load-row button {
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

.tt-persona-empty {
    font-size: 0.8em;
    opacity: 0.7;
    padding: 6px 0;
}

.tt-persona-note {
    font-size: 0.75em;
    opacity: 0.6;
    padding: 2px 0 4px;
}
</style>
