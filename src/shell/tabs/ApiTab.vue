<template>
  <!--
    「API」tab：服务商接入身份维护（列表/增删改/拉模型清单）＋任务模型
    （五行档案，各任务独立选服务商与模型）＋生成注入（破限预设）。
    url+key＝服务商，模型选择权在任务模型卡——两层分离。
    页面用 ui/ 原语组件拼装；控件皮肤在 .tt-ctrl、按钮在 .tt-btn，
    字号/间距只走 --tt-* 令牌，本样式只余页面私有布局与信息行。
  -->
  <div class="tt-api-tab">
    <TTCard title="API 服务商" :sub="PROVIDERS_SUB">
      <div v-if="!apis.endpoints.length" class="tt-api-empty">
        还没有服务商——点下方「新增服务商」开始配置。
      </div>

      <div v-for="p in apis.endpoints" :key="p.id" class="tt-api-row">
        <div class="tt-api-row-main">
          <span class="tt-api-name">{{ p.name || '（未命名）' }}</span>
          <span class="tt-api-url" :title="p.url">{{ p.url || '（未填地址）' }}</span>
          <span class="tt-api-model">{{ p.models.length > 0 ? `${p.models.length} 个模型` : '未拉取清单' }}</span>
          <span class="tt-api-key" :title="p.key ? '密钥已保存（打码显示）' : '未填密钥'">{{ maskKey(p.key) }}</span>
        </div>
        <div class="tt-api-row-actions">
          <button type="button" class="tt-btn" @click="apis.startDraft(p)">编辑</button>
          <button type="button" class="tt-btn tt-btn--danger" @click="confirmRemove(p)">删除</button>
        </div>
      </div>

      <button type="button" class="tt-btn" @click="apis.startDraft()">新增服务商</button>
    </TTCard>

    <TTCard title="任务模型" :sub="TASKS_SUB">
      <div class="tt-task-grid" role="grid">
        <div class="tt-task-grid-row tt-task-grid-head" role="row">
          <span class="tt-task-grid-cell tt-task-grid-cell--name" role="presentation" />
          <span class="tt-task-grid-cell" role="columnheader">服务商</span>
          <span class="tt-task-grid-cell" role="columnheader">模型</span>
          <span class="tt-task-grid-cell" role="columnheader">温度</span>
          <span class="tt-task-grid-cell" role="columnheader">思考</span>
        </div>
        <div v-for="t in TASKS" :key="t.id" class="tt-task-grid-row" role="row">
          <span class="tt-task-grid-cell tt-task-grid-cell--name" role="rowheader">
            <span class="tt-task-label">{{ t.label }}</span>
            <TTStatus v-if="profileStatus(t.id) === 'dangling'" tone="err">所选服务商已删除，请重新选择</TTStatus>
            <TTStatus v-else-if="profileStatus(t.id) === 'empty'" tone="muted">未配置</TTStatus>
          </span>
          <span class="tt-task-grid-cell" role="gridcell">
            <select
              class="tt-ctrl"
              :value="apis.taskProfiles[t.id].providerId"
              aria-label="服务商"
              @change="onProviderChange(t.id, $event)"
            >
              <option value="">（未选择）</option>
              <option v-for="p in apis.endpoints" :key="p.id" :value="p.id">{{ p.name || p.url }}</option>
            </select>
          </span>
          <span class="tt-task-grid-cell" role="gridcell">
            <TTCombobox
              :model-value="apis.taskProfiles[t.id].model"
              :options="providerModels(t.id)"
              :empty-text="modelEmptyText(t.id)"
              placeholder="模型 ID（可从所选服务商清单选）"
              aria-label="模型"
              @update:model-value="onModelInput(t.id, $event)"
            />
          </span>
          <span class="tt-task-grid-cell" role="gridcell">
            <input
              class="tt-ctrl"
              :value="apis.taskProfiles[t.id].temperature ?? ''"
              type="number"
              min="0"
              max="2"
              step="0.1"
              placeholder="默认"
              aria-label="温度"
              @change="onTemperatureInput(t.id, $event)"
            >
          </span>
          <span class="tt-task-grid-cell" role="gridcell">
            <select
              class="tt-ctrl"
              :value="apis.taskProfiles[t.id].reasoningEffort ?? ''"
              aria-label="思考"
              @change="onEffortChange(t.id, $event)"
            >
              <option value="">默认（{{ effortLabel(TASK_PARAMS[t.id].defaultReasoningEffort) }}）</option>
              <option v-for="e in EFFORT_OPTIONS" :key="e.value" :value="e.value">{{ e.label }}</option>
            </select>
          </span>
        </div>
      </div>

      <div class="tt-api-hint">推荐参数（调乱后照此恢复）：选项生成/人设生成＝温度 1.0·思考高；小总结/大总结＝温度 0.7·思考高；总结判断＝温度 0.2·思考高（配 Flash 可按体验自调）。</div>
    </TTCard>

    <TTCard title="生成注入" :sub="JB_SUB">
      <TTField label="破限预设">
        <select class="tt-ctrl" :value="apis.jailbreakPreset" @change="onJbPresetChange">
          <option value="">不启用</option>
          <option v-for="name in apis.presetNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </TTField>
      <div v-if="jbMissing" class="tt-api-notice">
        <TTStatus tone="err">选中预设「{{ apis.jailbreakPreset }}」已不存在——生成将不带注入，请重选或切回「不启用」</TTStatus>
      </div>
      <template #details>{{ JB_DETAILS }}</template>
    </TTCard>

    <TTCard v-if="apis.draft" :title="isEdit ? '编辑服务商' : '新服务商'">
      <TTField label="名称">
        <input v-model.trim="apis.draft.name" class="tt-ctrl" type="text" placeholder="如：DeepSeek 官方 / 某中转站">
      </TTField>
      <TTField label="地址">
        <input v-model.trim="apis.draft.url" class="tt-ctrl" type="text" placeholder="https://api.example.com/v1">
      </TTField>
      <TTField label="密钥">
        <input v-model.trim="apis.draft.key" class="tt-ctrl" type="text" autocomplete="off" placeholder="sk-…">
      </TTField>

      <div class="tt-api-model-edit">
        <span class="tt-api-model-edit-label">模型清单</span>
        <span class="tt-api-model">{{ apis.draft.models.length > 0 ? `已缓存 ${apis.draft.models.length} 个模型` : '未拉取' }}</span>
        <button type="button" class="tt-btn" :disabled="modelsLoading" @click="onFetchModels">拉模型清单</button>
      </div>

      <div class="tt-api-actions">
        <button type="button" class="tt-btn" @click="onSave">保存</button>
        <button type="button" class="tt-btn" @click="apis.cancelDraft()">取消</button>
      </div>
      <div v-if="draftError" class="tt-api-notice">
        <TTStatus tone="err">{{ draftError }}</TTStatus>
      </div>
      <div v-else-if="apis.fetchStatus" class="tt-api-notice">
        <TTStatus :tone="apis.fetchStatus.ok ? 'ok' : 'err'">{{ apis.fetchStatus.message }}</TTStatus>
      </div>
    </TTCard>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApisStore } from '@/modules/apis/store';
import { TASKS, type TaskId } from '@/tasks';
import { TASK_PARAMS } from '@/modules/apis/task-defaults';
import type { ReasoningEffort } from '@/modules/apis/client';
import type { ApiProvider } from '@/modules/apis/types';
import { TTCard, TTCombobox, TTField, TTStatus } from '@/shell/ui';

const apis = useApisStore();

const modelsLoading = ref(false);
const draftError = ref('');

// 卡片描述走常量：模板属性里换行会掺空格，逐字文案只有常量能所见即所写
const PROVIDERS_SUB = '这里只管接入身份（地址＋密钥），各生成任务用什么模型在下方「任务模型」卡按行选择。密钥经宿主后端转发直达上游，不存进宿主的密钥库。';
const TASKS_SUB = '每个生成任务独立选择服务商与模型；温度留空或改回即用推荐档，思考强度同理。模型下拉来自所选服务商的清单缓存，也可直接手填模型 ID。';
const JB_SUB = '选中宿主预设的「启用文本条目」会插到创作类任务每次请求的最前，人设两段链每段都带；预设不存在或无启用条目时生成不带注入（运行日志有记录）。';
const JB_DETAILS = '按原角色插入（assistant 开场就还是 assistant）。预设的采样参数不生效——温度与思考强度在「任务模型」卡按任务配置。人设页已无任务级预设——预设对生成的影响只经此处注入（全插件唯一预设口）。';

const EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
    { value: 'off', label: '关' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
];

function effortLabel(effort: ReasoningEffort): string {
    return EFFORT_OPTIONS.find(e => e.value === effort)?.label ?? effort;
}

// 破限注入：清单存 apis store（tab 的 onActivate 钩子刷新——本页容器只
// 挂载一次，宿主侧增删预设后回本页即新鲜）；挂载兜底刷一次
onMounted(() => {
    apis.refreshPresetNames();
});
const jbMissing = computed(() => apis.jailbreakPreset !== '' && !apis.presetNames.includes(apis.jailbreakPreset));

function onJbPresetChange(event: Event): void {
    apis.selectJailbreakPreset((event.target as HTMLSelectElement).value);
}

const isEdit = computed(() => apis.endpoints.some(p => p.id === apis.draft?.id));

function maskKey(key: string): string {
    if (!key) return '（未填密钥）';
    if (key.length <= 6) return '····';
    return `${key.slice(0, 6)}····`;
}

function confirmRemove(provider: ApiProvider): void {
    const label = provider.name || provider.url || '该服务商';
    // 删除是破坏性操作：确认后执行；引用它的任务档案行由存储层联动重置
    if (!window.confirm(`确定删除「${label}」？引用它的任务模型行会一并清空。该操作不可撤销。`)) return;
    apis.removeEndpoint(provider.id);
}

/** 行状态：悬空（服务商已删）/空（未配置）/就绪不显示。 */
function profileStatus(task: TaskId): 'empty' | 'dangling' | 'ready' {
    const profile = apis.taskProfiles[task];
    if (!profile.providerId) return 'empty';
    return apis.endpoints.some(p => p.id === profile.providerId) ? 'ready' : 'dangling';
}

function providerModels(task: TaskId): string[] {
    const providerId = apis.taskProfiles[task].providerId;
    return apis.endpoints.find(p => p.id === providerId)?.models ?? [];
}

/** 模型候选空态文案：区分「没选服务商」与「选了但没清单」两种指引。 */
function modelEmptyText(task: TaskId): string {
    return apis.taskProfiles[task].providerId
        ? '该服务商暂无模型清单，可直接手填'
        : '请先选择服务商，或直接手填模型 ID';
}

function onProviderChange(task: TaskId, event: Event): void {
    // 换服务商不保留旧模型（模型属于服务商），回未配置态等用户重选
    apis.updateTaskProfile(task, { providerId: (event.target as HTMLSelectElement).value, model: '' });
}

/** 模型值唯一写通道（手填与候选选中同路），trim 语义在此收口。 */
function onModelInput(task: TaskId, value: string): void {
    apis.updateTaskProfile(task, { model: value.trim() });
}

function onTemperatureInput(task: TaskId, event: Event): void {
    const raw = (event.target as HTMLInputElement).value.trim();
    // 空/非法＝回任务默认档（档案字段缺席语义）；合法值钳制归 normalize 写通道
    if (raw === '') {
        apis.updateTaskProfile(task, { temperature: undefined });
        return;
    }
    const value = Number(raw);
    apis.updateTaskProfile(task, { temperature: Number.isFinite(value) ? value : undefined });
}

function onEffortChange(task: TaskId, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    apis.updateTaskProfile(task, { reasoningEffort: value === '' ? undefined : (value as ReasoningEffort) });
}

async function onFetchModels(): Promise<void> {
    const draft = apis.draft;
    if (!draft) return;
    if (!draft.url) {
        draftError.value = '请先填写地址再拉取模型清单';
        return;
    }
    draftError.value = '';
    modelsLoading.value = true;
    try {
        await apis.fetchModelList();
        apis.fetchStatus = draft.models.length > 0
            ? { ok: true, message: `已拉取 ${draft.models.length} 个模型（保存后各任务模型行可直接选）` }
            : { ok: false, message: '清单为空——请检查地址与密钥（部分站点不开放模型清单接口）' };
    } catch (err) {
        apis.fetchStatus = { ok: false, message: `拉取失败：${err instanceof Error ? err.message : String(err)}` };
    } finally {
        modelsLoading.value = false;
    }
}

function onSave(): void {
    const draft = apis.draft;
    if (!draft) return;
    // fail fast：地址是请求的硬前提，缺了保存只会把坏档写进表
    if (!draft.url) {
        draftError.value = '保存前请至少填写地址';
        return;
    }
    const toSave: ApiProvider = { ...draft, name: draft.name || draft.url };
    apis.saveProvider(toSave);
    apis.cancelDraft();
}
</script>

<style scoped>
.tt-api-empty {
    font-size: var(--tt-fs-aux);
    opacity: 0.7;
    padding: var(--tt-sp-2) 0;
}

.tt-api-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--tt-sp-2);
    padding: var(--tt-sp-2) var(--tt-sp-1);
    border-bottom: 1px dashed var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.3));
}

.tt-api-row-main {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--tt-sp-3);
    min-width: 0;
    flex: 1;
    font-size: var(--tt-fs-aux);
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
    font-size: var(--tt-fs-hint);
}

.tt-api-row-actions {
    display: flex;
    align-items: center;
    gap: var(--tt-sp-2);
    flex-shrink: 0;
}

/* 任务模型卡：单表头 ARIA 网格——列头只说一次，控件关联靠 aria-label */
.tt-task-grid {
    display: flex;
    flex-direction: column;
}

.tt-task-grid-row {
    display: grid;
    grid-template-columns: minmax(5em, 0.9fr) minmax(0, 1.1fr) minmax(0, 1.5fr) minmax(4.5em, 0.6fr) minmax(0, 0.9fr);
    gap: var(--tt-sp-1) var(--tt-sp-2);
    align-items: center;
    padding: var(--tt-sp-1) 0;
    border-bottom: 1px dashed var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.3));
}

.tt-task-grid-cell {
    display: flex;
    align-items: center;
    min-width: 0;
}

.tt-task-grid-cell > .tt-ctrl,
.tt-task-grid-cell > .tt-combobox {
    width: 100%;
}

.tt-task-grid-cell--name {
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--tt-sp-1) var(--tt-sp-2);
}

.tt-task-grid-head .tt-task-grid-cell {
    font-size: var(--tt-fs-hint);
    opacity: 0.65;
}

.tt-task-label {
    font-weight: 600;
    font-size: var(--tt-fs-aux);
}

/* 窄壳回退：任务名整行、四控件两列两行（程序化关联靠 aria-label 兜底） */
@media (max-width: 480px) {
    .tt-task-grid-row {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }

    .tt-task-grid-cell--name {
        grid-column: 1 / -1;
    }
}

.tt-api-hint {
    font-size: var(--tt-fs-hint);
    opacity: 0.65;
    padding-top: var(--tt-sp-2);
}

.tt-api-model-edit {
    display: flex;
    align-items: center;
    gap: var(--tt-sp-2);
    flex: 1;
    min-width: 12em;
    padding: var(--tt-sp-1) 0;
}

.tt-api-model-edit-label {
    min-width: 4em;
    opacity: 0.8;
    flex-shrink: 0;
    font-size: var(--tt-fs-aux);
}

.tt-api-actions {
    display: flex;
    gap: var(--tt-sp-2);
    padding-top: var(--tt-sp-2);
}

.tt-api-notice {
    padding-top: var(--tt-sp-2);
}
</style>
