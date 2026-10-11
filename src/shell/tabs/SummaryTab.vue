<template>
  <!--
    「总结」tab：自动开关＋节奏参数＋状态行＋操作行＋大总结编辑。
    状态行读数全部经 store getters（与触发守卫同源算术）；生成中整行
    替换为取消形态（choice/persona 同款长请求逃生）。还原为两段确认
    免弹窗：第一次点击变红，3 秒内再点生效。
    页面用 ui/ 原语组件拼装；控件皮肤在 .tt-ctrl、按钮在 .tt-btn。
    整页单卡不传 title（页面名由 tab 纽扣承载）。
  -->
  <div class="tt-summary-tab">
    <TTCard>
      <!-- 开关行 -->
      <label class="tt-check-row">
        <input type="checkbox" :checked="store.settings.autoEnabled" @change="onToggleAuto">
        自动总结
      </label>
      <div class="tt-summary-hint">自动检查更早楼层：固定轮数＝攒满一轮间隔即折叠总结；事件感知＝区间内让判断模型识别剧情段落节点、到强制线不再询问直接总结，小总结攒够批数自动合并大总结</div>

      <!-- 参数行（失焦钳制：写通道归一，显示值随 revision 回读归一化结果） -->
      <div class="tt-summary-params">
        <TTField label="触发模式">
          <select class="tt-ctrl" :value="store.settings.triggerMode" @change="onModeChange">
            <option value="fixed">固定轮数</option>
            <option value="adaptive">事件感知</option>
          </select>
        </TTField>
        <TTField label="小总结间隔（轮）">
          <input class="tt-ctrl" type="number" min="1" max="20" :value="store.settings.intervalRounds" @change="onNumberChange('intervalRounds', $event)">
        </TTField>
        <TTField label="原文保留（轮）">
          <input class="tt-ctrl" type="number" min="1" max="20" :value="store.settings.keepRounds" @change="onNumberChange('keepRounds', $event)">
        </TTField>
        <TTField label="大总结间隔（批）">
          <input class="tt-ctrl" type="number" min="2" max="10" :value="store.settings.bigEvery" @change="onNumberChange('bigEvery', $event)">
        </TTField>
        <template v-if="store.settings.triggerMode === 'adaptive'">
          <TTField label="强制线（轮）">
            <input class="tt-ctrl" type="number" :min="store.settings.intervalRounds + 2" max="40" :value="store.settings.maxIntervalRounds" @change="onNumberChange('maxIntervalRounds', $event)">
          </TTField>
          <TTField label="询问间隔（轮）">
            <input class="tt-ctrl" type="number" min="1" max="10" :value="store.settings.judgeEveryRounds" @change="onNumberChange('judgeEveryRounds', $event)">
          </TTField>
        </template>
      </div>

      <!-- 状态行 -->
      <div class="tt-summary-status">
        已总结 {{ store.hiddenCount }} 楼｜未折叠小总结 {{ store.smallCount }} 条｜大总结 {{ store.bigSummary ? `有，${store.bigSummary.length} 字` : '无' }}｜{{ store.triggerStatus }}
      </div>

      <!-- 端点行 -->
      <div class="tt-summary-endpoint">生成端点：与选项生成共用当前活动端点（{{ store.endpointLabel }}）</div>

      <!-- 操作行：生成中整行替换为取消形态 -->
      <div v-if="!store.isRunning" class="tt-summary-actions">
        <button type="button" class="tt-btn" @click="store.runManualSmall()">立即小总结</button>
        <button type="button" class="tt-btn" @click="store.runManualBig()">立即大总结</button>
        <button type="button" class="tt-btn" @click="toggleEditor">{{ bigEditorOpen ? '收起大总结' : '查看/编辑大总结' }}</button>
        <button type="button" class="tt-btn" :class="{ 'tt-summary-restore--armed': restoreArmed }" @click="onRestoreClick">
          {{ restoreArmed ? '再点一次确认还原（不可撤销）' : '还原全部' }}
        </button>
      </div>
      <div v-else class="tt-summary-actions">
        <span class="tt-summary-running">{{ store.runningKind === 'big' ? '正在生成大总结…' : '正在生成小总结…' }}</span>
        <button type="button" class="tt-btn" @click="cancelGeneration">取消</button>
      </div>

      <!-- 大总结查看/编辑 -->
      <div v-if="bigEditorOpen" class="tt-summary-editor">
        <textarea v-model="bigDraft" class="tt-ctrl tt-ctrl--area" rows="8" placeholder="大总结正文……" />
        <button type="button" class="tt-btn" @click="saveBig">保存</button>
      </div>

      <!-- 面板底部说明 -->
      <div class="tt-summary-note">与预设自带的总结/摘要正则建议只开一层，避免双层注入</div>
    </TTCard>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { cancelSummaryGeneration } from '@/modules/summary/generator';
import { useSummaryStore } from '@/modules/summary/store';
import type { SummarySettings } from '@/modules/summary/settings';
import { TTCard, TTField } from '@/shell/ui';

const store = useSummaryStore();

const bigEditorOpen = ref(false);
const bigDraft = ref('');
const restoreArmed = ref(false);
let restoreTimer: ReturnType<typeof setTimeout> | null = null;

function onToggleAuto(event: Event): void {
    store.updateSettings({ autoEnabled: (event.target as HTMLInputElement).checked });
}

function onNumberChange(key: 'intervalRounds' | 'keepRounds' | 'bigEvery' | 'maxIntervalRounds' | 'judgeEveryRounds', event: Event): void {
    const raw = Number((event.target as HTMLInputElement).value);
    // 非有限或清空输入（Number('')===0）不写 patch：折成 0 会被钳到下界
    // 而非回退默认（0 是合法越界值的语义误导）；不写则显示值随回读保持原值。
    if (!Number.isFinite(raw) || raw < 1) return;
    const patch: Partial<SummarySettings> = {};
    patch[key] = raw;
    store.updateSettings(patch);
}

function onModeChange(event: Event): void {
    const mode = (event.target as HTMLSelectElement).value;
    // 枚举外值不写 patch（显示值随回读保持原值——写通道归一同款纪律）
    if (mode !== 'fixed' && mode !== 'adaptive') return;
    store.updateSettings({ triggerMode: mode });
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
    gap: var(--tt-sp-2);
}

.tt-summary-hint {
    font-size: var(--tt-fs-hint);
    opacity: 0.65;
    margin-top: var(--tt-sp-1);
}

.tt-summary-params {
    margin: var(--tt-sp-2) 0 var(--tt-sp-1);
}

.tt-summary-status {
    font-size: var(--tt-fs-aux);
    padding: var(--tt-sp-2) 0;
    border-top: 1px solid var(--SmartThemeBorderColor, #555);
    margin-top: var(--tt-sp-2);
}

.tt-summary-endpoint {
    font-size: var(--tt-fs-hint);
    opacity: 0.7;
    padding: var(--tt-sp-1) 0 var(--tt-sp-2);
}

.tt-summary-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tt-sp-2);
    margin-bottom: var(--tt-sp-2);
}

.tt-summary-running {
    font-size: var(--tt-fs-aux);
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
    gap: var(--tt-sp-2);
    margin-top: var(--tt-sp-2);
}

.tt-summary-editor > .tt-btn {
    align-self: flex-end;
}

.tt-summary-note {
    font-size: var(--tt-fs-hint);
    opacity: 0.6;
    padding-top: var(--tt-sp-2);
}
</style>
