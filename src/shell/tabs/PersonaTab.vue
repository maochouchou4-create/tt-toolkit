<template>
  <!--
    「人设」tab（PersonaWeaver 概念的壳内简化形态）。
    单 tab 纵向卡片流：人设编织＋落库与载入两卡；生成通道与生成参考
    收 <details> 折叠块。生成通道＝全局活动端点只读展示＋persona 任务参数
    （端点身份与选择都在「API」页维护）。
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
        <button type="button" :disabled="store.isProcessing" @click="store.generate()">
          {{ store.isProcessing ? (store.processingLabel || '处理中…') : '生成人设' }}
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

    <!-- ================= 折叠：生成通道 ================= -->
    <!-- 初始展开态＝setup 快照（未选端点时展开保证首用引导可见），选中端点后不强制收起 -->
    <details :open="channelFoldOpen" class="tt-persona-fold">
      <summary>生成通道</summary>
      <div class="tt-card">
        <div class="tt-card-sub">
          人设生成使用全局活动端点（在「API」页点「使用」切换）；此处只调人设任务参数。
        </div>

        <div class="tt-persona-field">
          <span>当前端点</span>
          <span class="tt-persona-endpoint-value">{{ apis.activeEndpoint ? `${apis.activeEndpoint.name || '（未命名）'} · ${apis.activeEndpoint.model || '未填模型'}` : '未选择' }}</span>
          <button type="button" class="tt-persona-link" @click="goApi">到「API」页切换</button>
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
          <button type="button" :disabled="!apis.activeEndpoint" @click="store.runTestConnection()">测试连接</button>
        </div>
        <div v-if="store.connectionStatus" class="tt-persona-conn">{{ store.connectionStatus }}</div>
      </div>
    </details>

    <!-- ================= 折叠：生成参考 ================= -->
    <details class="tt-persona-fold">
      <summary>生成参考</summary>
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
import { useApisStore } from '@/modules/apis/store';
import { useShellStore } from '@/shell/store';

const store = usePersonaStore();
const apis = useApisStore();
const shell = useShellStore();

/** 载入世界书条目的下拉选择值（索引字符串）。 */
const loadCandidateKey = ref('');

/** 生成通道折叠的初始展开态：未选端点时展开（首用引导可见）。
 *  只做 setup 一次性判定——绑定受控 :open 会在选中端点瞬间强制收起，
 *  把超时/流式/测连在配置流正中藏走；快照后用户开合自由。 */
const channelFoldOpen = apis.activeEndpointId === '';

function confirmClear(): void {
    if (!confirm('清空需求/结果？（已落库的配置不受影响）')) return;
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

/* 全局活动端点只读值：占满中段（选择器带父类限定压过上面的 min-width 基线） */
.tt-persona-field > .tt-persona-endpoint-value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
