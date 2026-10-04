<template>
  <!--
    选项生成设置：生成通道（统一端点表引用＋choice 任务参数）＋生成参数。
    端点实体（增删改/测连/拉模型）在「API」页维护，此处只做选择与参数。
    视觉从简：卡片化＋SmartTheme 变量（复用壳的 .tt-card 体系）。
  -->
  <div class="tt-choice-settings-tab">
    <div class="tt-card">
      <div class="tt-card-title">生成通道</div>
      <div class="tt-card-sub">
        独立旁路请求（不走宿主生成通道）；密钥经宿主后端转发直达上游。
        实测档位：DeepSeek 官方端点请选「JSON 对象」（不支持结构化 schema）；GG 类假流式端点必须开「流式」。
      </div>
      <label v-if="apis.endpoints.length" class="tt-choice-field">
        <span>生成端点</span>
        <select :value="settings.activeEndpointId" @change="onEndpointChange">
          <option value="" disabled>（选择端点）</option>
          <option v-for="e in apis.endpoints" :key="e.id" :value="e.id">{{ e.name || '（未命名）' }} · {{ e.model || '未填模型' }}</option>
        </select>
      </label>
      <div v-else class="tt-choice-empty">
        未配置端点——<button type="button" class="tt-choice-link" @click="goApi">到「API」页添加</button>
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
      <label class="tt-choice-field">
        <span>max_tokens</span>
        <input :value="settings.task.maxTokens" type="number" step="1" min="1" @change="onMaxTokensChange">
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

    <!-- 剧情走向卡已挪走（m03359 整合轮）：走向是提示词素材，编辑入口随
         「提示词」tab；数据域（chat 域 storyDirection）与写入通道零改动 -->
  </div>
</template>

<script setup lang="ts">
import { useChoiceSettingsStore } from '@/modules/choice/settings';
import { useApisStore } from '@/modules/apis/store';
import { useShellStore } from '@/shell/store';
import type { ChoiceGenParams, ChoiceTaskParams } from '@/modules/choice/api';

const settings = useChoiceSettingsStore();
const apis = useApisStore();
const shell = useShellStore();

function targetValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}

function onEndpointChange(event: Event): void {
    settings.setActiveEndpoint(targetValue(event));
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

function onMaxTokensChange(event: Event): void {
    settings.updateTask({ maxTokens: Number(targetValue(event)) || 2048 });
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

/* 剧情走向卡的样式（field--block/tags/tag/presets 系列）已随卡片挪进
   PromptEditorTab（tt-prompt- 前缀自持，m03359） */
</style>
