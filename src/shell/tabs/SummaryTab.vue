<template>
  <!--
    「总结」tab：自动开关＋节奏参数＋状态行＋操作行＋大总结编辑。
    状态行读数全部经 store getters（与触发守卫同源算术）；生成中整行
    替换为取消形态（choice/persona 同款长请求逃生）。还原为两段确认
    免弹窗：第一次点击变红，3 秒内再点生效。
    视觉从简：卡片化复用壳层 .tt-card 体系，类名前缀 tt-summary-。
  -->
  <div class="tt-summary-tab">
    <div class="tt-card">
      <!-- 开关行 -->
      <div class="tt-summary-switch">
        <label class="tt-summary-switch-label">
          <input type="checkbox" :checked="store.settings.autoEnabled" @change="onToggleAuto">
          自动总结
        </label>
        <div class="tt-summary-hint">每轮回复后自动检查：更早楼层攒够一轮间隔即折叠并总结，小总结攒够批数自动合并大总结</div>
      </div>

      <!-- 参数行（失焦钳制：写通道归一，显示值随 revision 回读归一化结果） -->
      <div class="tt-summary-params">
        <label>小总结间隔（轮）<input type="number" min="1" max="20" :value="store.settings.intervalRounds" @change="onNumberChange('intervalRounds', $event)"></label>
        <label>原文保留（轮）<input type="number" min="1" max="20" :value="store.settings.keepRounds" @change="onNumberChange('keepRounds', $event)"></label>
        <label>大总结间隔（批）<input type="number" min="2" max="10" :value="store.settings.bigEvery" @change="onNumberChange('bigEvery', $event)"></label>
      </div>

      <!-- 状态行 -->
      <div class="tt-summary-status">
        已总结 {{ store.hiddenCount }} 楼｜未折叠小总结 {{ store.smallCount }} 条｜大总结 {{ store.bigSummary ? `有，${store.bigSummary.length} 字` : '无' }}｜再聊 {{ store.roundsLeft }} 轮触发小总结
      </div>

      <!-- 端点行 -->
      <div class="tt-summary-endpoint">生成端点：与选项生成共用当前活动端点（{{ store.endpointLabel }}）</div>

      <!-- 操作行：生成中整行替换为取消形态 -->
      <div v-if="!store.isRunning" class="tt-actions">
        <button type="button" @click="store.runManualSmall()">立即小总结</button>
        <button type="button" @click="store.runManualBig()">立即大总结</button>
        <button type="button" @click="toggleEditor">{{ bigEditorOpen ? '收起大总结' : '查看/编辑大总结' }}</button>
        <button type="button" :class="{ 'tt-summary-restore--armed': restoreArmed }" @click="onRestoreClick">
          {{ restoreArmed ? '再点一次确认还原（不可撤销）' : '还原全部' }}
        </button>
      </div>
      <div v-else class="tt-actions">
        <span class="tt-summary-running">{{ store.runningKind === 'big' ? '正在生成大总结…' : '正在生成小总结…' }}</span>
        <button type="button" @click="cancelGeneration">取消</button>
      </div>

      <!-- 大总结查看/编辑 -->
      <div v-if="bigEditorOpen" class="tt-summary-editor">
        <textarea v-model="bigDraft" class="tt-summary-area" rows="8" placeholder="大总结正文……" />
        <button type="button" @click="saveBig">保存</button>
      </div>

      <!-- 面板底部说明 -->
      <div class="tt-summary-note">与预设自带的总结/摘要正则建议只开一层，避免双层注入</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { cancelSummaryGeneration } from '@/modules/summary/generator';
import { useSummaryStore } from '@/modules/summary/store';
import type { SummarySettings } from '@/modules/summary/settings';

const store = useSummaryStore();

const bigEditorOpen = ref(false);
const bigDraft = ref('');
const restoreArmed = ref(false);
let restoreTimer: ReturnType<typeof setTimeout> | null = null;

function onToggleAuto(event: Event): void {
    store.updateSettings({ autoEnabled: (event.target as HTMLInputElement).checked });
}

function onNumberChange(key: 'intervalRounds' | 'keepRounds' | 'bigEvery', event: Event): void {
    const raw = Number((event.target as HTMLInputElement).value);
    // 非有限或清空输入（Number('')===0）不写 patch：折成 0 会被钳到下界
    // 而非回退默认（0 是合法越界值的语义误导）；不写则显示值随回读保持原值。
    if (!Number.isFinite(raw) || raw < 1) return;
    const patch: Partial<SummarySettings> = {};
    patch[key] = raw;
    store.updateSettings(patch);
}

function toggleEditor(): void {
    if (!bigEditorOpen.value) bigDraft.value = store.bigSummary;
    bigEditorOpen.value = !bigEditorOpen.value;
}

function saveBig(): void {
    store.saveBigSummary(bigDraft.value);
}

/** 两段确认：第一次点击进入武装态（3 秒窗口），再点生效，超时复原。 */
function onRestoreClick(): void {
    if (!restoreArmed.value) {
        restoreArmed.value = true;
        if (restoreTimer !== null) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
            restoreArmed.value = false;
            restoreTimer = null;
        }, 3000);
        return;
    }
    if (restoreTimer !== null) {
        clearTimeout(restoreTimer);
        restoreTimer = null;
    }
    restoreArmed.value = false;
    store.restoreAll();
}

function cancelGeneration(): void {
    cancelSummaryGeneration();
}
</script>

<style scoped>
.tt-summary-tab {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.tt-summary-switch-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: bold;
    cursor: pointer;
}

.tt-summary-hint {
    font-size: 0.78em;
    opacity: 0.65;
    margin-top: 3px;
}

.tt-summary-params {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 8px 0 4px;
}

.tt-summary-params label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 0.82em;
    opacity: 0.85;
}

.tt-summary-params input {
    width: 5em;
    box-sizing: border-box;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 3px 6px;
}

.tt-summary-status {
    font-size: 0.82em;
    padding: 5px 0;
    border-top: 1px solid var(--SmartThemeBorderColor, #555);
    margin-top: 6px;
}

.tt-summary-endpoint {
    font-size: 0.78em;
    opacity: 0.7;
    padding: 2px 0 6px;
}

.tt-summary-running {
    font-size: 0.85em;
    opacity: 0.85;
    align-self: center;
}

.tt-summary-restore--armed {
    color: var(--SmartThemeRedColor, #c0392b);
    border-color: var(--SmartThemeRedColor, #c0392b);
    font-weight: bold;
}

.tt-summary-editor {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: 6px;
}

.tt-summary-editor button {
    align-self: flex-end;
}

.tt-summary-area {
    width: 100%;
    box-sizing: border-box;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 6px 8px;
    font-size: 0.85em;
    resize: vertical;
}

.tt-summary-note {
    font-size: 0.75em;
    opacity: 0.6;
    padding-top: 6px;
}
</style>
