<template>
  <!--
    选项生成设置：生成参数（含每轮自动生成/按分类轮询开关——生成行为
    参数归一处）＋走向指引（提示词 tab 删除后唯一存留的提示词入口）。
    输出契约/流式按任务固化（TASK_PARAMS），温度/思考强度与模型选择唯一
    入口＝「API」页「任务模型」卡——本页不再有生成通道卡。
    页面用 ui/ 原语组件拼装；控件皮肤在 .tt-ctrl、按钮在 .tt-btn，
    本样式只余走向指引区私有布局与信息行。
  -->
  <div class="tt-choice-settings-tab">
    <TTCard title="生成参数">
      <label class="tt-check-row">
        <input :checked="settings.gen.autoGenerate" type="checkbox" @change="onAutoToggle">
        <span>AI 回复后自动生成选项（生成中 / 未配 API 自动跳过）</span>
      </label>
      <label class="tt-check-row">
        <input :checked="settings.gen.categoriesEnabled" type="checkbox" @change="onCategoriesToggle">
        <span>按分类轮询（每轮选项尽量来自不同分类，保证多样性）</span>
      </label>
      <TTField label="每次生成条数">
        <input class="tt-ctrl" :value="settings.gen.count" type="number" min="1" max="10" @change="settings.updateGen({ count: clampInt($event, 1, 10, 4) })">
      </TTField>
      <TTField label="候选倍率（%）">
        <input class="tt-ctrl" :value="settings.gen.oversamplePct" type="number" min="0" max="500" step="10" @change="settings.updateGen({ oversamplePct: clampInt($event, 0, 500, 100) })">
      </TTField>
      <div class="tt-choice-hint">提示词候选 ≈ {{ candidateEstimate }} 条（1 条固定项＋随机抽取，随上方条数与倍率变化）</div>
      <TTField label="上下文轮数（一轮＝一问一答）">
        <input class="tt-ctrl" :value="settings.gen.contextRounds" type="number" min="1" max="50" @change="settings.updateGen({ contextRounds: clampInt($event, 1, 50, 6) })">
      </TTField>
      <TTField label="选项字数下限">
        <input class="tt-ctrl" :value="settings.gen.minChars" type="number" min="0" max="200" @change="settings.updateGen({ minChars: clampInt($event, 0, 200, 10) })">
      </TTField>
      <TTField label="选项字数上限">
        <input class="tt-ctrl" :value="settings.gen.maxChars" type="number" min="10" max="500" @change="settings.updateGen({ maxChars: clampInt($event, 10, 500, 60) })">
      </TTField>
      <TTField label="点击选项后">
        <select class="tt-ctrl" :value="settings.gen.clickBehavior" @change="onBehaviorChange">
          <option value="fill">填入输入框（可编辑后手动发送）</option>
          <option value="append">追加到输入框末尾</option>
          <option value="send">直接发送</option>
        </select>
      </TTField>
    </TTCard>

    <!-- 剧情走向卡（提示词 tab 整页删除后，这里是唯一
         存留的提示词入口——用户拍板「走向指引」卡保留；数据域（chat 域
         storyDirection）与写入通道零改动，老用户的走向文本/预设不丢） -->
    <TTCard title="走向指引" :sub="DIRECTION_SUB">
      <TTField label="自由文本（主位）" block>
        <textarea
          class="tt-ctrl tt-ctrl--area"
          :value="direction.storyDirection.freeText"
          rows="3"
          placeholder="如：让林霜主动坦白昨夜去向的真相，并暴露她与斗篷人的旧关联"
          @input="onDirectionTextInput"
        />
      </TTField>
      <div class="tt-prompt-presets">
        <div class="tt-prompt-presets-head">
          <span>我的预设</span>
          <button type="button" class="tt-btn" :disabled="!direction.storyDirection.freeText.trim()" title="把当前走向指引文本存为预设（全局保存，所有聊天可用）" @click="saveCurrentTextAsPreset">存为预设</button>
        </div>
        <div v-if="direction.directionPresets.length === 0" class="tt-choice-empty">
          还没有预设——写好走向指引后点「存为预设」，以后一条点击应用
        </div>
        <div v-else class="tt-prompt-tags">
          <button
            v-for="preset in direction.directionPresets"
            :key="preset.id"
            type="button"
            class="tt-btn"
            :class="{ 'tt-prompt-tag--active': direction.storyDirection.presetText === preset.text }"
            :title="preset.text"
            @click="togglePreset(preset)"
          >
            {{ presetLabel(preset) }}
            <span class="tt-prompt-tag-del" title="删除该预设（不影响已应用的聊天）" @click.stop="removePreset(preset)">×</span>
          </button>
        </div>
        <div v-if="direction.storyDirection.presetText" class="tt-prompt-note">
          已应用预设：{{ direction.storyDirection.presetText }}（再点同一预设可取消应用）
        </div>
      </div>
    </TTCard>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue';
import { useChoiceSettingsStore } from '@/modules/choice/settings';
import { useStoryDirectionStore, type DirectionPreset } from '@/modules/choice/direction';
import type { ChoiceGenParams } from '@/modules/choice/api';
import { TTCard, TTField } from '@/shell/ui';

const settings = useChoiceSettingsStore();
const direction = useStoryDirectionStore();

// 卡片描述走常量：模板属性里换行会掺空格，逐字文案只有常量能所见即所写；
// 「；」后的半角空格＝原模板换行折叠的渲染产物，原样保留保渲染文本不变
const DIRECTION_SUB = '走向答「剧情往哪走」：写一两句话告诉 AI 这轮剧情往哪个方向推进（随当前聊天保存）； 留空＝不注入走向。';

function targetValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}

function onBehaviorChange(event: Event): void {
    settings.updateGen({ clickBehavior: targetValue(event) as ChoiceGenParams['clickBehavior'] });
}

function onAutoToggle(event: Event): void {
    settings.updateGen({ autoGenerate: (event.target as HTMLInputElement).checked });
}

function onCategoriesToggle(event: Event): void {
    settings.updateGen({ categoriesEnabled: (event.target as HTMLInputElement).checked });
}

function clampInt(event: Event, min: number, max: number, fallback: number): number {
    const value = Number(targetValue(event));
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.round(value)));
}

// 候选估算＝1 固定项＋(条数−1) 抽取基数×(1＋倍率)，与 resolver.drawAmount
// 同式（条数≤10、倍率≤500 时恒小于池大小，无需封顶展示）
const candidateEstimate = computed(() => {
    const drawn = settings.gen.count - 1;
    const pct = Number.isFinite(settings.gen.oversamplePct) && settings.gen.oversamplePct > 0 ? settings.gen.oversamplePct : 0;
    return 1 + drawn + Math.ceil((drawn * pct) / 100);
});

// ---- 剧情走向卡（随提示词 tab 删除从 PromptEditorTab
//      搬回本页；数据域与写入通道零改动） ----

// 自由文本防抖：每击键立即 setStoryDirection＝每击键一次 chat 域立即保存
// （saveMetadata 通道）——保存风暴。停输入 300ms 才落盘；预设应用/取消
// 是单次点击、保持立即保存，不进防抖。
const DIRECTION_TEXT_DEBOUNCE_MS = 300;
let directionTextTimer: ReturnType<typeof setTimeout> | undefined;

function onDirectionTextInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    if (directionTextTimer !== undefined) clearTimeout(directionTextTimer);
    directionTextTimer = setTimeout(() => {
        directionTextTimer = undefined;
        direction.setStoryDirection({ freeText: value });
    }, DIRECTION_TEXT_DEBOUNCE_MS);
}

function presetLabel(preset: DirectionPreset): string {
    // 预设无独立名字段（最小形态：预设＝文本本体）——标签条显示
    // 截断文本，完整内容在 title 悬浮
    const text = preset.text.trim();
    return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

/** 点击预设＝应用（写入 presetText 快照）；再点同一预设＝取消应用。 */
function togglePreset(preset: DirectionPreset): void {
    if (direction.storyDirection.presetText === preset.text) {
        direction.setStoryDirection({ presetText: '' });
    } else {
        direction.setStoryDirection({ presetText: preset.text });
    }
}

function saveCurrentTextAsPreset(): void {
    const text = direction.storyDirection.freeText.trim();
    if (!text) return;
    direction.addDirectionPreset(text);
}

function removePreset(preset: DirectionPreset): void {
    if (!confirm(`删除预设「${presetLabel(preset)}」？（已应用该预设的聊天不受影响）`)) return;
    direction.deleteDirectionPreset(preset.id);
}

// 防抖挂起期间离开设置页（含切聊天后卸载）：不落盘半截文本——
// 落盘目标 chat 域可能已随卸载切换，迟到的写会进错聊天
onBeforeUnmount(() => {
    if (directionTextTimer !== undefined) clearTimeout(directionTextTimer);
});
</script>

<style>
/* 选项生成设置 tab：卡片/字段/开关行/按钮走原语层（TTCard/TTField/
   .tt-check-row/.tt-btn/.tt-ctrl），此处只余走向指引区私有布局与信息行 */
.tt-choice-empty {
    font-size: var(--tt-fs-aux);
    opacity: 0.7;
    padding: var(--tt-sp-2) 0;
}

/* 生成参数卡信息行：候选条数随设置的实时换算 */
.tt-choice-hint {
    font-size: var(--tt-fs-hint);
    opacity: 0.6;
    padding: var(--tt-sp-1) 0;
}

/* 剧情走向区（从 PromptEditorTab 搬回）：tt-prompt- 前缀自持，
   别与 .tt-choice- 系列互串语义；块级字段与编辑区皮肤已归 TTField block／.tt-ctrl--area */

.tt-prompt-presets-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--tt-sp-1);
}

.tt-prompt-presets-head > span {
    font-size: var(--tt-fs-aux);
    opacity: 0.8;
}

.tt-prompt-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tt-sp-1);
}

/* 预设应用态：.tt-btn 之上的状态修饰（非皮肤） */
.tt-prompt-tag--active {
    border-color: var(--SmartThemeQuoteColor, #c58a36);
}

.tt-prompt-tag-del {
    /* 删除叉与标签文本同为按钮内容——独立悬浮态只归删除叉 */
    display: inline-block;
    margin-left: var(--tt-sp-2);
    padding: 0 var(--tt-sp-1);
    opacity: 0.55;
}

.tt-prompt-tag-del:hover {
    opacity: 1;
    color: var(--SmartThemeQuoteColor, #c58a36);
}

.tt-prompt-note {
    font-size: var(--tt-fs-hint);
    opacity: 0.6;
    padding: var(--tt-sp-1) 0 0;
}
</style>
