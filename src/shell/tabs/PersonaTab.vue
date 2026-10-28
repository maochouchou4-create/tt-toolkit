<template>
  <!--
    「人设」tab（PersonaWeaver 概念的壳内简化形态）。
    单 tab 纵向卡片流：人设编织单卡；生成参考收 <details>
    折叠块。流式/超时按任务固化（TASK_PARAMS），模型与温度/思考强度的
    唯一入口＝「API」页「任务模型」卡（未配置由 generate 的
    fail-fast toast 引导）。生成按钮双态：进行中点击＝取消（长请求逃生
    姿势与导航「生成」键同款）。
    页面用 ui/ 原语组件拼装；控件皮肤在 .tt-ctrl、按钮在 .tt-btn。
  -->
  <div class="tt-persona-tab">
    <!-- ================= 卡：人设编织 ================= -->
    <TTCard title="人设编织" sub="AI 生成人设 YAML（末轮模型复核查重）→ 手改 → 写回宿主人设">
      <!-- 需求框（有结果时折叠） -->
      <details :open="!store.hasResult" class="tt-persona-details">
        <summary>生成需求</summary>
        <textarea
          v-model="store.requestText"
          class="tt-ctrl tt-ctrl--area tt-persona-area"
          rows="4"
          :placeholder="TEXT.PERSONA_REQUEST_PLACEHOLDER"
        />
      </details>

      <div class="tt-btn-row tt-persona-actions">
        <button type="button" class="tt-btn" @click="onGenerateClick">
          {{ store.isProcessing ? `${store.processingLabel || '处理中…'} · 停止` : '生成人设' }}
        </button>
        <button v-if="store.hasResult" type="button" class="tt-btn" :disabled="store.isProcessing" @click="store.reroll()">重 roll</button>
        <button v-if="store.hasResult" type="button" class="tt-btn" @click="confirmClear">清空</button>
        <button type="button" class="tt-btn" :disabled="!store.hasResult" @click="onOverwritePersona">覆盖当前人设</button>
      </div>

      <!-- 结果框（可手改；生成/重 roll 共用） -->
      <textarea
        v-model="store.resultText"
        class="tt-ctrl tt-ctrl--area tt-persona-area tt-persona-area--result"
        rows="12"
        placeholder="生成结果（YAML）……"
      />

      <!-- 复核简报（常驻一行；文案在 strings.ts 的 TEXT.REVIEW_BRIEF）。
           文案只读 store 派生，不进结果框：结果框经 upsertPersona 进宿主
           persona_description、经 inject_persona 进此后每一轮对话，一行 UI
           文案混进去就是每轮提示词里都漂着它。常驻渲染（不 v-if），
           卡片高度不随结果有无跳变。字号/弱化走 TTStatus 原语，
           本 tab 只管它作为一行的位置。 -->
      <div class="tt-persona-brief">
        <TTStatus tone="muted">{{ store.reviewBriefText }}</TTStatus>
      </div>
    </TTCard>

    <!-- ================= 折叠：生成参考 ================= -->
    <details class="tt-persona-fold">
      <summary>生成参考</summary>
      <TTCard title="开场白" sub="注入哪一条开场白作为生成参考（默认第一条；「不注入」仅本聊天内保留）">
        <select v-if="store.greetings.length > 0" :value="store.selectedGreetingIndex === null ? '' : String(store.selectedGreetingIndex)" class="tt-ctrl tt-persona-greeting" @change="onGreetingChange">
          <option v-for="(g, i) in store.greetings" :key="i" :value="String(i)">{{ g.label }}</option>
          <option value="">不注入开场白</option>
        </select>
        <div v-else class="tt-persona-empty">进入角色会话后可选择开场白</div>
      </TTCard>

      <TTCard title="世界书">
        <div v-if="store.boundBooks.length > 0" class="tt-persona-note">已全量注入绑定世界书：{{ store.boundBooks.join('、') }}</div>
        <div v-else class="tt-persona-empty">当前角色未绑定世界书</div>
      </TTCard>
    </details>
  </div>
</template>

<script setup lang="ts">
import { TEXT, overwritePersonaGuarded, usePersonaStore } from '@/modules/persona';
import { TTCard, TTStatus } from '@/shell/ui';

const store = usePersonaStore();

function confirmClear(): void {
    if (!confirm('清空需求/结果？（已落库的配置不受影响）')) return;
    store.clearAll();
}

/**
 * 覆盖写回：宿主正文偏离我方上次同步的快照时先问一次。
 * 弹窗与文案归本层（仓内 confirm 先例），判据与快照比对在 store；拒答即
 * 中止，宿主不碰、结果框里的编辑现场原样留着。
 */
function onOverwritePersona(): void {
    void overwritePersonaGuarded(store, () => confirm(TEXT.CONFIRM_OVERWRITE_HOST));
}

/** 生成按钮双态：空闲＝发起生成；进行中＝取消（长请求逃生，导航「生成」键同款）。 */
function onGenerateClick(): void {
    if (store.isProcessing) store.cancelGeneration();
    else void store.generate();
}

function onGreetingChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    store.selectGreeting(value === '' ? null : Number(value));
}
</script>

<style>
/* 人设 tab 私有布局与信息行（tt-persona- 前缀）；卡片/按钮/控件皮肤
   走原语层（按钮行的排布与间距走 .tt-btn-row），大编辑区 textarea 保留
   纯样式类 */
.tt-persona-actions {
    margin-bottom: var(--tt-sp-2);
}

/* persona/yaml 语境特化：等宽字体（皮肤在 .tt-ctrl--area 单点） */
.tt-persona-area {
    font-family: var(--monospaceFontFamily, monospace);
}

.tt-persona-area--result {
    min-height: 12em;
}

/* 复核简报行：只留行块位置（上边距），字号与弱化由 TTStatus 原语承担 */
.tt-persona-brief {
    padding: var(--tt-sp-1) 0 0;
}

.tt-persona-details {
    margin: var(--tt-sp-1) 0;
}

.tt-persona-details summary {
    cursor: pointer;
    font-size: var(--tt-fs-aux);
    opacity: 0.8;
    padding: var(--tt-sp-1) 0;
}

.tt-persona-details[open] > summary {
    margin-bottom: var(--tt-sp-1);
}

.tt-persona-fold {
    margin: var(--tt-sp-2) 0;
}

.tt-persona-fold > summary {
    cursor: pointer;
    font-weight: bold;
    padding: var(--tt-sp-1) 0;
}

.tt-persona-fold[open] > summary {
    margin-bottom: var(--tt-sp-2);
}

/* 开场白下拉无字段行包裹，独立占满卡宽 */
.tt-persona-greeting {
    width: 100%;
}

.tt-persona-empty {
    font-size: var(--tt-fs-aux);
    opacity: 0.7;
    padding: var(--tt-sp-2) 0;
}

.tt-persona-note {
    font-size: var(--tt-fs-hint);
    opacity: 0.6;
    padding: var(--tt-sp-1) 0 var(--tt-sp-2);
}
</style>
