<template>
  <!--
    选项生成设置：生成通道（全局活动端点只读展示＋choice 任务参数）＋生成参数
    ＋走向指引（提示词 tab 删除后唯一存留的提示词入口）。
    端点实体与端点选择（「使用」按钮）都在「API」页维护，此处只读展示与调参。
    视觉从简：卡片化＋SmartTheme 变量（复用壳的 .tt-card 体系）。
  -->
  <div class="tt-choice-settings-tab">
    <div class="tt-card">
      <div class="tt-card-title">生成通道</div>
      <div class="tt-card-sub">
        独立旁路请求（不走宿主生成通道）；密钥经宿主后端转发直达上游。
        实测档位：DeepSeek 官方端点请选「JSON 对象」（不支持结构化 schema）；GG 类假流式端点必须开「流式」。
      </div>
      <div v-if="apis.activeEndpoint" class="tt-choice-field">
        <span>当前端点</span>
        <span class="tt-choice-endpoint-value">{{ apis.activeEndpoint.name || '（未命名）' }} · {{ apis.activeEndpoint.model || '未填模型' }}</span>
        <button type="button" class="tt-choice-link" @click="goApi">到「API」页切换</button>
      </div>
      <div v-else class="tt-choice-empty">
        未选择端点——<button type="button" class="tt-choice-link" @click="goApi">到「API」页选择</button>
      </div>
      <label class="tt-choice-field">
        <span>输出契约</span>
        <select :value="settings.task.outputContract" @change="onContractChange">
          <option value="json_object">JSON 对象（json_object，通用）</option>
          <option value="json_schema">结构化 schema（json_schema，GG/CC 支持）</option>
          <option value="prompt_only">纯提示词（不传 response_format）</option>
        </select>
      </label>
      <label class="tt-choice-field">
        <span>思考强度</span>
        <select :value="settings.task.reasoningEffort" @change="onEffortChange">
          <option value="off">不发送（默认）</option>
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </select>
      </label>
      <div class="tt-choice-note">思考强度：仅部分端点支持，发错档会被端点忽略或报错，默认不发</div>
      <label class="tt-choice-switch">
        <input :checked="settings.task.stream" type="checkbox" @change="onStreamToggle">
        <span>流式请求（假流式端点必开；长请求防挂死）</span>
      </label>
      <label class="tt-choice-field">
        <span>temperature</span>
        <input :value="settings.task.temperature" type="number" step="0.1" min="0" max="2" @change="onTemperatureChange">
      </label>
    </div>

    <div class="tt-card">
      <div class="tt-card-title">生成参数</div>
      <label class="tt-choice-field">
        <span>每次生成条数</span>
        <input :value="settings.gen.count" type="number" min="1" max="10" @change="settings.updateGen({ count: clampInt($event, 1, 10, 4) })">
      </label>
      <label class="tt-choice-field">
        <span>上下文轮数（一轮＝一问一答）</span>
        <input :value="settings.gen.contextRounds" type="number" min="1" max="50" @change="settings.updateGen({ contextRounds: clampInt($event, 1, 50, 6) })">
      </label>
      <label class="tt-choice-field">
        <span>选项字数下限</span>
        <input :value="settings.gen.minChars" type="number" min="0" max="200" @change="settings.updateGen({ minChars: clampInt($event, 0, 200, 10) })">
      </label>
      <label class="tt-choice-field">
        <span>选项字数上限</span>
        <input :value="settings.gen.maxChars" type="number" min="10" max="500" @change="settings.updateGen({ maxChars: clampInt($event, 10, 500, 60) })">
      </label>
      <label class="tt-choice-field">
        <span>点击选项后</span>
        <select :value="settings.gen.clickBehavior" @change="onBehaviorChange">
          <option value="fill">填入输入框（可编辑后手动发送）</option>
          <option value="append">追加到输入框末尾</option>
          <option value="send">直接发送</option>
        </select>
      </label>
    </div>

    <!-- 剧情走向卡（提示词 tab 整页删除后，这里是唯一
         存留的提示词入口——用户拍板「走向指引」卡保留；数据域（chat 域
         storyDirection）与写入通道零改动，老用户的走向文本/预设不丢） -->
    <div class="tt-card">
      <div class="tt-card-title">走向指引</div>
      <div class="tt-card-sub">
        走向答「剧情往哪走」：写一两句话告诉 AI 这轮剧情往哪个方向推进（随当前聊天保存）；
        留空＝不注入走向。
      </div>
      <label class="tt-prompt-field--block">
        <span>自由文本（主位）</span>
        <textarea
          :value="direction.storyDirection.freeText"
          rows="3"
          placeholder="如：让林霜主动坦白昨夜去向的真相，并暴露她与斗篷人的旧关联"
          @input="onDirectionTextInput"
        />
      </label>
      <div class="tt-prompt-presets">
        <div class="tt-prompt-presets-head">
          <span>我的预设</span>
          <button type="button" :disabled="!direction.storyDirection.freeText.trim()" title="把当前走向指引文本存为预设（全局保存，所有聊天可用）" @click="saveCurrentTextAsPreset">存为预设</button>
        </div>
        <div v-if="direction.directionPresets.length === 0" class="tt-choice-empty">
          还没有预设——写好走向指引后点「存为预设」，以后一条点击应用
        </div>
        <div v-else class="tt-prompt-tags">
          <button
            v-for="preset in direction.directionPresets"
            :key="preset.id"
            type="button"
            class="tt-prompt-tag"
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { useChoiceSettingsStore } from '@/modules/choice/settings';
import { useStoryDirectionStore, type DirectionPreset } from '@/modules/choice/direction';
import { useApisStore } from '@/modules/apis/store';
import { useShellStore } from '@/shell/store';
import type { ChoiceGenParams, ChoiceTaskParams } from '@/modules/choice/api';

const settings = useChoiceSettingsStore();
const apis = useApisStore();
const shell = useShellStore();
const direction = useStoryDirectionStore();

function targetValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}

function onContractChange(event: Event): void {
    settings.updateTask({ outputContract: targetValue(event) as ChoiceTaskParams['outputContract'] });
}

function onEffortChange(event: Event): void {
    settings.updateTask({ reasoningEffort: targetValue(event) as ChoiceTaskParams['reasoningEffort'] });
}

function onStreamToggle(event: Event): void {
    settings.updateTask({ stream: (event.target as HTMLInputElement).checked });
}

function onTemperatureChange(event: Event): void {
    settings.updateTask({ temperature: Number(targetValue(event)) || 0.7 });
}

function onBehaviorChange(event: Event): void {
    settings.updateGen({ clickBehavior: targetValue(event) as ChoiceGenParams['clickBehavior'] });
}

function clampInt(event: Event, min: number, max: number, fallback: number): number {
    const value = Number(targetValue(event));
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.round(value)));
}

function goApi(): void {
    shell.activate('api');
}

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
/* 选项生成设置 tab（scoped 样式对本 tab 独立维护；卡片壳复用壳层 .tt-card） */
.tt-choice-field {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 0.85em;
}

.tt-choice-field > span {
    min-width: 9em;
    opacity: 0.8;
    flex-shrink: 0;
}

/* 全局活动端点只读行：取值文本占满中段，切换动作收在右侧链接
   （选择器带父类限定压过 .tt-choice-field > span 的 min-width 基线） */
.tt-choice-field > .tt-choice-endpoint-value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tt-choice-note {
    font-size: 0.75em;
    opacity: 0.6;
    padding: 0 0 4px calc(9em + 8px);
}

.tt-choice-field input,
.tt-choice-field select,
.tt-choice-field textarea {
    flex: 1;
    min-width: 0;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 3px 6px;
    font-size: 0.95em;
}

.tt-choice-switch {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 0.85em;
    cursor: pointer;
}

.tt-choice-empty {
    font-size: 0.8em;
    opacity: 0.7;
    padding: 6px 0;
}

.tt-choice-link {
    background: transparent;
    color: var(--SmartThemeQuoteColor, #c58a36);
    border: none;
    padding: 0;
    font-size: 1em;
    cursor: pointer;
    text-decoration: underline;
}

/* 剧情走向卡（从 PromptEditorTab 搬回）：类名沿用 tt-prompt- 前缀自持
   （原宿主文件已删，无冲突——别与上面 .tt-choice- 系列互串语义） */
.tt-prompt-field--block {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 6px;
    font-size: 0.85em;
}

.tt-prompt-field--block textarea {
    background: color-mix(in srgb, var(--SmartThemeBorderColor, #666) 18%, transparent);
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 4px 6px;
    font-family: inherit;
    font-size: 0.9em;
    resize: vertical;
}

.tt-prompt-presets-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.85em;
    opacity: 0.8;
    margin-bottom: 4px;
}

.tt-prompt-presets-head button {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 10px;
    font-size: 0.85em;
    cursor: pointer;
}

.tt-prompt-presets-head button:disabled {
    opacity: 0.4;
    cursor: default;
}

.tt-prompt-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.tt-prompt-tag {
    background: color-mix(in srgb, var(--SmartThemeBorderColor, #666) 25%, transparent);
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 0.8em;
    cursor: pointer;
}

.tt-prompt-tag--active {
    border-color: var(--SmartThemeQuoteColor, #c58a36);
}

.tt-prompt-tag-del {
    /* 删除叉与标签文本同为按钮内容——独立悬浮态只归删除叉 */
    display: inline-block;
    margin-left: 6px;
    padding: 0 2px;
    opacity: 0.55;
}

.tt-prompt-tag-del:hover {
    opacity: 1;
    color: var(--SmartThemeQuoteColor, #c58a36);
}

.tt-prompt-note {
    font-size: 0.75em;
    opacity: 0.6;
    padding: 4px 0 0;
}
</style>
