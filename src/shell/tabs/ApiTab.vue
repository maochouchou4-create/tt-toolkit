<template>
  <!--
    「API」tab：服务商接入身份维护（列表/增删改/拉模型清单）＋任务模型
    （五行档案，各任务独立选服务商与模型）＋生成注入（破限预设）。
    url+key＝服务商，模型选择权在任务模型卡——两层分离。
    视觉照 .tt-card 体系；类名前缀 tt-api-。
  -->
  <div class="tt-api-tab">
    <div class="tt-card">
      <div class="tt-card-title">API 服务商</div>
      <div class="tt-card-sub">
        这里只管接入身份（地址＋密钥），各生成任务用什么模型在下方「任务模型」卡按行选择。
        密钥经宿主后端转发直达上游，不存进宿主的密钥库。
      </div>

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
          <button type="button" class="tt-api-btn" @click="apis.startDraft(p)">编辑</button>
          <button type="button" class="tt-api-btn tt-api-btn-danger" @click="confirmRemove(p)">删除</button>
        </div>
      </div>

      <button type="button" class="tt-api-btn" @click="apis.startDraft()">新增服务商</button>
    </div>

    <div class="tt-card">
      <div class="tt-card-title">任务模型</div>
      <div class="tt-card-sub">
        每个生成任务独立选择服务商与模型；温度留空或改回即用推荐档，思考强度同理。
        模型下拉来自所选服务商的清单缓存，也可直接手填模型 ID。
      </div>

      <div v-for="t in TASKS" :key="t.id" class="tt-task-row">
        <div class="tt-task-head">
          <span class="tt-task-label">{{ t.label }}</span>
          <span v-if="profileStatus(t.id) === 'dangling'" class="tt-api-status" data-ok="false">所选服务商已删除，请重新选择</span>
          <span v-else-if="profileStatus(t.id) === 'empty'" class="tt-api-status">未配置</span>
        </div>
        <div class="tt-task-fields">
          <label class="tt-api-field">
            <span>服务商</span>
            <select :value="apis.taskProfiles[t.id].providerId" @change="onProviderChange(t.id, $event)">
              <option value="">（未选择）</option>
              <option v-for="p in apis.endpoints" :key="p.id" :value="p.id">{{ p.name || p.url }}</option>
            </select>
          </label>
          <label class="tt-api-field">
            <span>模型</span>
            <input
              :value="apis.taskProfiles[t.id].model"
              type="text"
              list="tt-task-model-options"
              placeholder="模型 ID（可从所选服务商清单选）"
              @change="onModelInput(t.id, $event)"
            >
          </label>
          <label class="tt-api-field">
            <span>温度</span>
            <input
              :value="apis.taskProfiles[t.id].temperature ?? ''"
              type="number"
              min="0"
              max="2"
              step="0.1"
              placeholder="默认"
              @change="onTemperatureInput(t.id, $event)"
            >
          </label>
          <label class="tt-api-field">
            <span>思考</span>
            <select :value="apis.taskProfiles[t.id].reasoningEffort ?? ''" @change="onEffortChange(t.id, $event)">
              <option value="">默认（{{ effortLabel(TASK_PARAMS[t.id].defaultReasoningEffort) }}）</option>
              <option v-for="e in EFFORT_OPTIONS" :key="e.value" :value="e.value">{{ e.label }}</option>
            </select>
          </label>
        </div>
        <select v-if="providerModels(t.id).length" class="tt-api-model-select" @change="onModelPick(t.id, $event)">
          <option value="" disabled>（从 {{ providerName(t.id) }} 的清单选择模型）</option>
          <option v-for="m in providerModels(t.id)" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
      <datalist id="tt-task-model-options">
        <option v-for="m in selectedTaskModels" :key="m" :value="m" />
      </datalist>

      <div class="tt-api-hint">推荐参数（调乱后照此恢复）：选项生成/人设生成＝温度 1.0·思考高；小总结/大总结＝温度 0.7·思考高；总结判断＝温度 0.2·思考高（配 Flash 可按体验自调）。</div>
    </div>

    <div class="tt-card">
      <div class="tt-card-title">生成注入</div>
      <div class="tt-card-sub">
        破限预设：选中宿主预设的「启用文本条目」会按原角色（assistant 开场就还是 assistant）插到创作类任务每次请求的最前，人设两段链每段都带。
        预设的采样参数不生效——温度与思考强度在「任务模型」卡按任务配置。
        人设页已无任务级预设——预设对生成的影响只经此处注入（全插件唯一预设口）；预设不存在或无启用文本条目时生成将不带注入（运行日志有记录）。
      </div>
      <label class="tt-api-field">
        <span>破限预设</span>
        <select :value="apis.jailbreakPreset" @change="onJbPresetChange">
          <option value="">不启用</option>
          <option v-for="name in apis.presetNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <div v-if="jbMissing" class="tt-api-status" data-ok="false">
        选中预设「{{ apis.jailbreakPreset }}」已不存在——生成将不带注入，请重选或切回「不启用」
      </div>
    </div>

    <div v-if="apis.draft" class="tt-card">
      <div class="tt-card-title">{{ isEdit ? '编辑服务商' : '新服务商' }}</div>
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
        <span>模型清单</span>
        <div class="tt-api-model-edit">
          <span class="tt-api-model">{{ apis.draft.models.length > 0 ? `已缓存 ${apis.draft.models.length} 个模型` : '未拉取' }}</span>
          <button type="button" class="tt-api-btn" :disabled="modelsLoading" @click="onFetchModels">拉模型清单</button>
        </div>
      </div>

      <div class="tt-api-actions">
        <button type="button" class="tt-api-btn" @click="onSave">保存</button>
        <button type="button" class="tt-api-btn" @click="apis.cancelDraft()">取消</button>
      </div>
      <div v-if="draftError" class="tt-api-status" data-ok="false">{{ draftError }}</div>
      <div v-else-if="apis.fetchStatus" class="tt-api-status" :data-ok="apis.fetchStatus.ok">{{ apis.fetchStatus.message }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApisStore } from '@/modules/apis/store';
import { TASKS, type TaskId } from '@/tasks';
import { TASK_PARAMS } from '@/modules/apis/task-defaults';
import type { ReasoningEffort } from '@/modules/apis/client';
import type { ApiProvider } from '@/modules/apis/types';

const apis = useApisStore();

const modelsLoading = ref(false);
const draftError = ref('');

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

function providerName(task: TaskId): string {
    const providerId = apis.taskProfiles[task].providerId;
    const provider = apis.endpoints.find(p => p.id === providerId);
    return provider?.name || provider?.url || '';
}

/** 任务模型卡的手填 datalist 源：当前有服务商档的行的清单并集。 */
const selectedTaskModels = computed(() => {
    const ids = new Set(apis.endpoints.flatMap(p => p.models));
    return [...ids].sort();
});

function onProviderChange(task: TaskId, event: Event): void {
    // 换服务商不保留旧模型（模型属于服务商），回未配置态等用户重选
    apis.updateTaskProfile(task, { providerId: (event.target as HTMLSelectElement).value, model: '' });
}

function onModelInput(task: TaskId, event: Event): void {
    apis.updateTaskProfile(task, { model: (event.target as HTMLInputElement).value.trim() });
}

function onModelPick(task: TaskId, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value) apis.updateTaskProfile(task, { model: value });
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
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

/* 任务模型卡：一行一任务（任务名＋四字段＋清单下拉） */
.tt-task-row {
    padding: 6px 4px;
    border-bottom: 1px dashed var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.3));
}

.tt-task-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
}

.tt-task-label {
    font-weight: 600;
    font-size: 0.85em;
}

.tt-task-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
}

.tt-task-fields .tt-api-field {
    flex: 1;
    min-width: 9em;
}

.tt-task-fields .tt-api-field > span {
    min-width: 3em;
}

.tt-api-hint {
    font-size: 0.75em;
    opacity: 0.65;
    padding-top: 8px;
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

.tt-api-field input,
.tt-api-field select {
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
    align-items: center;
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
