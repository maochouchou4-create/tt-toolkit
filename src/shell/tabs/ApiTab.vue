<template>
  <!--
    「API」tab：统一端点表维护（列表/增删改/测连/拉模型清单）。
    choice 与 persona 共用这张表，端点身份（地址/密钥/模型）只在这里管。
    视觉照 .tt-card 体系；类名前缀 tt-api-。
  -->
  <div class="tt-api-tab">
    <div class="tt-card">
      <div class="tt-card-title">API 端点</div>
      <div class="tt-card-sub">
        选项生成与人设生成共用这里的端点；到各自设置页的「生成通道」里选择用哪一个。
        密钥经宿主后端转发直达上游，不存进宿主的密钥库。
      </div>

      <div v-if="!apis.endpoints.length" class="tt-api-empty">
        还没有端点——点下方「新增端点」开始配置。
      </div>

      <div v-for="e in apis.endpoints" :key="e.id" class="tt-api-row">
        <div class="tt-api-row-main">
          <span class="tt-api-name">{{ e.name || '（未命名）' }}</span>
          <span class="tt-api-url" :title="e.url">{{ e.url || '（未填地址）' }}</span>
          <span class="tt-api-model">{{ e.model || '（未填模型）' }}</span>
          <span class="tt-api-key" :title="e.key ? '密钥已保存（打码显示）' : '未填密钥'">{{ maskKey(e.key) }}</span>
        </div>
        <div class="tt-api-row-actions">
          <button type="button" class="tt-api-btn" @click="apis.startDraft(e)">编辑</button>
          <button type="button" class="tt-api-btn tt-api-btn-danger" @click="confirmRemove(e)">删除</button>
        </div>
      </div>

      <button type="button" class="tt-api-btn" @click="apis.startDraft()">新增端点</button>
    </div>

    <div v-if="apis.draft" class="tt-card">
      <div class="tt-card-title">{{ isEdit ? '编辑端点' : '新端点' }}</div>
      <label class="tt-api-field">
        <span>名称</span>
        <input v-model.trim="apis.draft.name" type="text" placeholder="如：DeepSeek 官方 / 某中转站">
      </label>
      <label class="tt-api-field">
        <span>地址</span>
        <input v-model.trim="apis.draft.url" type="text" placeholder="https://api.example.com/v1">
      </label>
      <label class="tt-api-field">
        <span>密钥</span>
        <input v-model.trim="apis.draft.key" type="text" autocomplete="off" placeholder="sk-…">
      </label>
      <div class="tt-api-field">
        <span>模型名</span>
        <div class="tt-api-model-edit">
          <input v-model.trim="apis.draft.model" type="text" placeholder="模型 ID，可点右侧按钮拉取清单">
          <button type="button" class="tt-api-btn" :disabled="modelsLoading" @click="onFetchModels">拉模型清单</button>
        </div>
        <select v-if="apis.modelOptions.length" class="tt-api-model-select" @change="onPickModel">
          <option value="" disabled>（从清单选择模型）</option>
          <option v-for="m in apis.modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>

      <div class="tt-api-actions">
        <button type="button" class="tt-api-btn" :disabled="testing" @click="onTestConnection">测试连接</button>
        <button type="button" class="tt-api-btn" @click="onSave">保存</button>
        <button type="button" class="tt-api-btn" @click="apis.cancelDraft()">取消</button>
      </div>
      <div v-if="apis.connectionStatus" class="tt-api-status" :data-ok="apis.connectionStatus.ok">
        {{ apis.connectionStatus.message }}
      </div>
      <div v-else-if="testError" class="tt-api-status" data-ok="false">{{ testError }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useApisStore } from '@/modules/apis/store';
import type { ApiEndpoint } from '@/modules/apis/types';

const apis = useApisStore();

const testing = ref(false);
const modelsLoading = ref(false);
const testError = ref('');

const isEdit = computed(() => apis.endpoints.some(e => e.id === apis.draft?.id));

function maskKey(key: string): string {
    if (!key) return '（未填密钥）';
    if (key.length <= 6) return '····';
    return `${key.slice(0, 6)}····`;
}

function confirmRemove(endpoint: ApiEndpoint): void {
    const label = endpoint.name || endpoint.url || '该端点';
    // 删除是破坏性操作：确认后执行；两侧「生成通道」的选中引用悬空由各页引导兜底
    if (!window.confirm(`确定删除「${label}」？该操作不可撤销。`)) return;
    apis.removeEndpoint(endpoint.id);
}

async function onTestConnection(): Promise<void> {
    const draft = apis.draft;
    if (!draft) return;
    if (!draft.url || !draft.model) {
        testError.value = '请先填写地址与模型名再测试';
        return;
    }
    testError.value = '';
    testing.value = true;
    try {
        await apis.runTestConnection(draft.url, draft.key, draft.model);
    } finally {
        testing.value = false;
    }
}

async function onFetchModels(): Promise<void> {
    const draft = apis.draft;
    if (!draft) return;
    if (!draft.url) {
        testError.value = '请先填写地址再拉取模型清单';
        return;
    }
    testError.value = '';
    modelsLoading.value = true;
    try {
        await apis.fetchModelList(draft.url, draft.key);
        if (!apis.modelOptions.length) {
            testError.value = '清单为空——请检查地址与密钥（部分站点不开放模型清单接口）';
        }
    } catch (err) {
        testError.value = `拉取失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
        modelsLoading.value = false;
    }
}

function onPickModel(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value) apis.updateDraft({ model: value });
}

function onSave(): void {
    const draft = apis.draft;
    if (!draft) return;
    // fail fast：地址与模型是请求的两个硬前提，缺了保存只会把坏档写进表
    if (!draft.url || !draft.model) {
        testError.value = '保存前请至少填写地址与模型名';
        return;
    }
    const toSave: ApiEndpoint = { ...draft, name: draft.name || draft.url };
    apis.saveEndpoint(toSave);
    apis.cancelDraft();
}
</script>

<style>
/* 「API」tab 样式（tt-api- 前缀自持；卡片壳复用壳层 .tt-card） */
.tt-api-empty {
    font-size: 0.8em;
    opacity: 0.7;
    padding: 6px 0;
}

.tt-api-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 4px;
    border-bottom: 1px dashed var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.3));
}

.tt-api-row-main {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    flex: 1;
    font-size: 0.85em;
}

.tt-api-name {
    font-weight: 600;
    min-width: 5em;
}

.tt-api-url {
    opacity: 0.75;
    max-width: 18em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tt-api-model {
    opacity: 0.85;
}

.tt-api-key {
    opacity: 0.5;
    font-size: 0.9em;
}

.tt-api-row-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
}

.tt-api-btn {
    background: var(--SmartThemeBlurTintColor, rgba(128, 128, 128, 0.15));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 3px 10px;
    font-size: 0.85em;
    cursor: pointer;
}

.tt-api-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.tt-api-btn-danger {
    color: var(--SmartThemeFontColorDanger, #b54b4b);
}

.tt-api-field {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 0.85em;
    flex-wrap: wrap;
}

.tt-api-field > span {
    min-width: 4em;
    opacity: 0.8;
    flex-shrink: 0;
}

.tt-api-field input {
    flex: 1;
    min-width: 10em;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 3px 6px;
    font-size: 0.95em;
}

.tt-api-model-edit {
    display: flex;
    gap: 6px;
    flex: 1;
    min-width: 12em;
}

.tt-api-model-select {
    width: 100%;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 3px 6px;
    font-size: 0.9em;
    margin-top: 4px;
}

.tt-api-actions {
    display: flex;
    gap: 8px;
    padding-top: 8px;
}

.tt-api-status {
    font-size: 0.8em;
    padding-top: 6px;
    opacity: 0.9;
}

.tt-api-status[data-ok='true'] {
    color: var(--SmartThemeQuoteColor, #4b8b5f);
}

.tt-api-status[data-ok='false'] {
    color: var(--SmartThemeFontColorDanger, #b54b4b);
}
</style>
