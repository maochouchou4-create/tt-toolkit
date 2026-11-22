<template>
  <!--
    选项生成设置：生成参数（含每轮自动生成开关与候选倍率池旋钮——
    生成行为参数归一处）。
    输出契约/流式按任务固化（TASK_PARAMS），温度/思考强度与模型选择唯一
    入口＝「API」页「任务模型」卡——本页不再有生成通道卡。
    页面用 ui/ 原语组件拼装；控件皮肤在 .tt-ctrl、按钮在 .tt-btn。
  -->
  <div class="tt-choice-settings-tab">
    <TTCard title="生成参数">
      <label class="tt-check-row">
        <input :checked="settings.gen.autoGenerate" type="checkbox" @change="onAutoToggle">
        <span>AI 回复后自动生成选项</span>
      </label>
      <TTField label="每次生成条数">
        <input class="tt-ctrl" :value="settings.gen.count" type="number" :min="GEN_PARAM_LIMITS.count.min" :max="GEN_PARAM_LIMITS.count.max" @change="settings.updateGen({ count: clampInt($event, GEN_PARAM_LIMITS.count, DEFAULT_GEN_PARAMS.count) })">
      </TTField>
      <TTField label="候选倍率（%）">
        <input class="tt-ctrl" :value="settings.gen.oversamplePct" type="number" :min="OVERSAMPLE_LIMITS.min" :max="OVERSAMPLE_LIMITS.max" :step="OVERSAMPLE_LIMITS.step" @change="settings.updateGen({ oversamplePct: clampInt($event, OVERSAMPLE_LIMITS, DEFAULT_GEN_PARAMS.oversamplePct) })">
      </TTField>
      <TTField label="选项字数下限">
        <input class="tt-ctrl" :value="settings.gen.minChars" type="number" :min="GEN_PARAM_LIMITS.minChars.min" :max="GEN_PARAM_LIMITS.minChars.max" @change="settings.updateGen({ minChars: clampInt($event, GEN_PARAM_LIMITS.minChars, DEFAULT_GEN_PARAMS.minChars) })">
      </TTField>
      <TTField label="选项字数上限">
        <input class="tt-ctrl" :value="settings.gen.maxChars" type="number" :min="GEN_PARAM_LIMITS.maxChars.min" :max="GEN_PARAM_LIMITS.maxChars.max" @change="settings.updateGen({ maxChars: clampInt($event, GEN_PARAM_LIMITS.maxChars, DEFAULT_GEN_PARAMS.maxChars) })">
      </TTField>
      <TTField label="点击选项后">
        <select class="tt-ctrl" :value="settings.gen.clickBehavior" @change="onBehaviorChange">
          <option value="fill">填入输入框</option>
          <option value="append">追加到输入框末尾</option>
          <option value="send">直接发送</option>
        </select>
      </TTField>
    </TTCard>
  </div>
</template>

<script setup lang="ts">
import { DEFAULT_GEN_PARAMS, GEN_PARAM_LIMITS, OVERSAMPLE_LIMITS, useChoiceSettingsStore, type ChoiceGenParams } from '@/modules/choice';
import { TTCard, TTField } from '@/shell/ui';

const settings = useChoiceSettingsStore();

function targetValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}

function onBehaviorChange(event: Event): void {
    settings.updateGen({ clickBehavior: targetValue(event) as ChoiceGenParams['clickBehavior'] });
}

function onAutoToggle(event: Event): void {
    settings.updateGen({ autoGenerate: (event.target as HTMLInputElement).checked });
}

/** 控件取值钳制：值域对象（GEN_PARAM_LIMITS／OVERSAMPLE_LIMITS 同形）直入，非数回落默认。 */
function clampInt(event: Event, limits: { min: number; max: number }, fallback: number): number {
    const value = Number(targetValue(event));
    if (!Number.isFinite(value)) return fallback;
    return Math.max(limits.min, Math.min(limits.max, Math.round(value)));
}
</script>

