<template>
  <!--
    选项生成设置：API 配置（全局域）＋生成参数＋剧情走向（chat 域）。
    视觉从简：卡片化＋SmartTheme 变量（复用壳的 .tt-card 体系）。
  -->
  <div class="tt-choice-settings-tab">
    <div class="tt-card">
      <div class="tt-card-title">API 端点</div>
      <div class="tt-card-sub">
        独立旁路请求（不走宿主生成通道）；密钥经宿主后端转发直达上游。
        实测档位：DeepSeek 官方端点请选「JSON 对象」（不支持结构化 schema）；GG 类假流式端点必须开「流式」。
      </div>
      <div class="tt-actions">
        <button type="button" @click="settings.startDraft()">新增端点</button>
      </div>
      <ul v-if="settings.apis.length" class="tt-choice-api-list">
        <li v-for="api in settings.apis" :key="api.id" class="tt-choice-api-row" :class="{ 'tt-choice-api-row--active': api.id === settings.activeApiId }">
          <div class="tt-choice-api-main">
            <button type="button" class="tt-choice-api-activate" :title="api.id === settings.activeApiId ? '当前生效端点' : '点选为生效端点'" @click="settings.activateApi(api.id)">
              {{ api.id === settings.activeApiId ? '生效中' : '启用' }}
            </button>
            <span class="tt-choice-api-name">{{ api.name || '（未命名）' }}</span>
            <span class="tt-choice-api-meta">{{ api.model || '未填模型' }} · {{ contractLabel(api.outputContract) }}{{ api.stream ? ' · 流式' : '' }}</span>
          </div>
          <div class="tt-choice-api-ops">
            <button type="button" @click="settings.startDraft(api)">编辑</button>
            <button type="button" class="tt-choice-api-op-danger" @click="confirmRemove(api)">删除</button>
          </div>
        </li>
      </ul>
      <div v-else class="tt-choice-empty">尚无端点——点「新增端点」配置（地址 / 密钥 / 模型）</div>

      <div v-if="settings.draft" class="tt-choice-api-draft">
        <div class="tt-card-title">{{ settings.apis.some(a => a.id === settings.draft?.id) ? '编辑端点' : '新端点' }}</div>
        <label class="tt-choice-field">
          <span>名称</span>
          <input v-model.trim="settings.draft.name" type="text" placeholder="如 CC / ds / GG">
        </label>
        <label class="tt-choice-field">
          <span>API 地址</span>
          <input v-model.trim="settings.draft.apiurl" type="text" placeholder="https://api.example.com/v1">
        </label>
        <label class="tt-choice-field">
          <span>密钥</span>
          <input v-model.trim="settings.draft.key" type="password" autocomplete="off" placeholder="sk-…">
        </label>
        <label class="tt-choice-field">
          <span>模型</span>
          <input v-model.trim="settings.draft.model" type="text" placeholder="model-id">
        </label>
        <label class="tt-choice-field">
          <span>输出契约</span>
          <select :value="settings.draft.outputContract" @change="onDraftContractChange">
            <option value="json_object">JSON 对象（json_object，通用）</option>
            <option value="json_schema">结构化 schema（json_schema，GG/CC 支持）</option>
            <option value="prompt_only">纯提示词（不传 response_format）</option>
          </select>
        </label>
        <label class="tt-choice-field">
          <span>思考强度</span>
          <select :value="settings.draft.reasoningEffort" @change="onDraftEffortChange">
            <option value="off">不发送（默认）</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </label>
        <div class="tt-choice-note">思考强度：仅部分端点支持，发错档会被端点忽略或报错，默认不发</div>
        <label class="tt-choice-switch">
          <input v-model="settings.draft.stream" type="checkbox">
          <span>流式请求（假流式端点必开；长请求防挂死）</span>
        </label>
        <label class="tt-choice-field">
          <span>temperature</span>
          <input :value="settings.draft.temperature" type="number" step="0.1" min="0" max="2" @change="onDraftTemperatureChange">
        </label>
        <label class="tt-choice-field">
          <span>max_tokens</span>
          <input :value="settings.draft.maxTokens" type="number" step="1" min="1" @change="onDraftMaxTokensChange">
        </label>
        <div class="tt-actions">
          <button type="button" @click="saveDraft">保存</button>
          <button type="button" @click="settings.cancelDraft()">取消</button>
        </div>
      </div>
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

    <div class="tt-card">
      <div class="tt-card-title">剧情走向</div>
      <div class="tt-card-sub">
        走向答「剧情往哪走」：写一两句话告诉 AI 这轮剧情往哪个方向推进（随当前聊天保存）；
        留空＝不注入走向。选项怎么写的通用约束在提示词编辑器的「写作规则」模块里改。
      </div>
      <label class="tt-choice-field tt-choice-field--block">
        <span>走向指引（自由文本，主位）</span>
        <textarea
          :value="prompts.storyDirection.freeText"
          rows="3"
          placeholder="如：让林霜主动坦白昨夜去向的真相，并暴露她与斗篷人的旧关联"
          @input="onDirectionTextInput"
        />
      </label>
      <div class="tt-choice-presets">
        <div class="tt-choice-presets-head">
          <span>我的预设</span>
          <button type="button" :disabled="!prompts.storyDirection.freeText.trim()" title="把当前走向指引文本存为预设（全局保存，所有聊天可用）" @click="saveCurrentTextAsPreset">存为预设</button>
        </div>
        <div v-if="prompts.directionPresets.length === 0" class="tt-choice-empty">
          还没有预设——写好走向指引后点「存为预设」，以后一条点击应用
        </div>
        <div v-else class="tt-choice-tags">
          <button
            v-for="preset in prompts.directionPresets"
            :key="preset.id"
            type="button"
            class="tt-choice-tag"
            :class="{ 'tt-choice-tag--active': prompts.storyDirection.presetText === preset.text }"
            :title="preset.text"
            @click="togglePreset(preset)"
          >
            {{ presetLabel(preset) }}
            <span class="tt-choice-tag-del" title="删除该预设（不影响已应用的聊天）" @click.stop="removePreset(preset)">×</span>
          </button>
        </div>
        <div v-if="prompts.storyDirection.presetText" class="tt-choice-note">
          已应用预设：{{ prompts.storyDirection.presetText }}（再点同一预设可取消应用）
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { useChoiceSettingsStore } from '@/modules/choice/settings';
import type { ApiConfig, ChoiceGenParams } from '@/modules/choice/api';
import { usePromptsStore, type DirectionPreset } from '@/prompts';

const settings = useChoiceSettingsStore();
const prompts = usePromptsStore();

// 自由文本防抖：每击键立即 setStoryDirection＝每击键一次 chat 域立即保存
// （saveMetadata 通道）——保存风暴。停输入 300ms 才落盘；预设应用/取消
// 是单次点击、保持立即保存，不进防抖。
const DIRECTION_TEXT_DEBOUNCE_MS = 300;
let directionTextTimer: ReturnType<typeof setTimeout> | undefined;

function onDirectionTextInput(event: Event): void {
    const value = targetValue(event);
    if (directionTextTimer !== undefined) clearTimeout(directionTextTimer);
    directionTextTimer = setTimeout(() => {
        directionTextTimer = undefined;
        prompts.setStoryDirection({ freeText: value });
    }, DIRECTION_TEXT_DEBOUNCE_MS);
}

function presetLabel(preset: DirectionPreset): string {
    // 预设无独立名字段（G4 最小形态：预设＝文本本体）——标签条显示
    // 截断文本，完整内容在 title 悬浮
    const text = preset.text.trim();
    return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

/** 点击预设＝应用（写入 presetText 快照）；再点同一预设＝取消应用。 */
function togglePreset(preset: DirectionPreset): void {
    if (prompts.storyDirection.presetText === preset.text) {
        prompts.setStoryDirection({ presetText: '' });
    } else {
        prompts.setStoryDirection({ presetText: preset.text });
    }
}

function saveCurrentTextAsPreset(): void {
    const text = prompts.storyDirection.freeText.trim();
    if (!text) return;
    prompts.addDirectionPreset(text);
}

function removePreset(preset: DirectionPreset): void {
    if (!confirm(`删除预设「${presetLabel(preset)}」？（已应用该预设的聊天不受影响）`)) return;
    prompts.deleteDirectionPreset(preset.id);
}

// 防抖挂起期间离开设置页（含切聊天后卸载）：不落盘半截文本——
// 落盘目标 chat 域可能已随卸载切换，迟到的写会进错聊天
onBeforeUnmount(() => {
    if (directionTextTimer !== undefined) clearTimeout(directionTextTimer);
});

function targetValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}

function onDraftContractChange(event: Event): void {
    settings.updateDraft({ outputContract: targetValue(event) as ApiConfig['outputContract'] });
}

function onDraftEffortChange(event: Event): void {
    settings.updateDraft({ reasoningEffort: targetValue(event) as ApiConfig['reasoningEffort'] });
}

function onDraftTemperatureChange(event: Event): void {
    settings.updateDraft({ temperature: Number(targetValue(event)) || 0.7 });
}

function onDraftMaxTokensChange(event: Event): void {
    settings.updateDraft({ maxTokens: Number(targetValue(event)) || 2048 });
}

function onBehaviorChange(event: Event): void {
    settings.updateGen({ clickBehavior: targetValue(event) as ChoiceGenParams['clickBehavior'] });
}

function contractLabel(contract: ApiConfig['outputContract']): string {
    if (contract === 'json_schema') return '结构化 schema';
    if (contract === 'json_object') return 'JSON 对象';
    return '纯提示词';
}

function clampInt(event: Event, min: number, max: number, fallback: number): number {
    const value = Number(targetValue(event));
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.round(value)));
}

function saveDraft(): void {
    const draft = settings.draft;
    if (!draft) return;
    if (!draft.apiurl.trim() || !draft.model.trim()) {
        alert('API 地址与模型不能为空（名称可选）');
        return;
    }
    settings.saveApi(draft);
    if (settings.apis.length === 1 && !settings.activeApiId) {
        settings.activateApi(draft.id);
    }
}

function confirmRemove(api: ApiConfig): void {
    if (!confirm(`删除端点「${api.name || api.apiurl}」？`)) return;
    settings.removeApi(api.id);
}
</script>

<style>
/* 选项生成设置 tab（scoped 样式对本 tab 独立维护；卡片壳复用壳层 .tt-card） */
.tt-choice-api-list {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
}

.tt-choice-api-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 2px;
    border-bottom: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor, #666) 40%, transparent);
}

.tt-choice-api-row--active .tt-choice-api-name {
    font-weight: bold;
}

.tt-choice-api-main {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
}

.tt-choice-api-activate {
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.15));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 8px;
    font-size: 0.78em;
    cursor: pointer;
    flex-shrink: 0;
}

.tt-choice-api-name {
    font-size: 0.88em;
    white-space: nowrap;
}

.tt-choice-api-meta {
    font-size: 0.75em;
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tt-choice-api-ops {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
}

.tt-choice-api-ops button {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 8px;
    font-size: 0.75em;
    cursor: pointer;
}

.tt-choice-api-op-danger:hover {
    color: var(--SmartThemeQuoteColor, #c58a36);
}

.tt-choice-api-draft {
    margin-top: 8px;
    border-top: 1px solid var(--SmartThemeBorderColor, #666);
    padding-top: 8px;
}

.tt-choice-empty {
    font-size: 0.8em;
    opacity: 0.6;
    padding: 6px 0;
}

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

.tt-choice-field--block {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
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

.tt-choice-field textarea {
    resize: vertical;
    font-family: inherit;
}

.tt-choice-switch {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 0.85em;
    cursor: pointer;
}

.tt-choice-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
}

.tt-choice-tag {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 999px;
    padding: 3px 12px;
    font-size: 0.82em;
    cursor: pointer;
    opacity: 0.75;
}

.tt-choice-tag:hover {
    opacity: 1;
}

.tt-choice-tag--active {
    opacity: 1;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.2));
    font-weight: bold;
}

.tt-choice-presets {
    margin-top: 4px;
}

.tt-choice-presets-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.85em;
    opacity: 0.8;
    margin-bottom: 4px;
}

.tt-choice-presets-head button {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 10px;
    font-size: 0.85em;
    cursor: pointer;
}

.tt-choice-presets-head button:disabled {
    opacity: 0.4;
    cursor: default;
}

.tt-choice-tag-del {
    /* 删除叉与标签文本同为按钮内容——独立悬浮态只归删除叉 */
    display: inline-block;
    margin-left: 6px;
    padding: 0 2px;
    opacity: 0.55;
}

.tt-choice-tag-del:hover {
    opacity: 1;
    color: var(--SmartThemeQuoteColor, #c58a36);
}
</style>
