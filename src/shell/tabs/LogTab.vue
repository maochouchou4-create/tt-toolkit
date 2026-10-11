<template>
  <!--
    运行日志页：生成记录列表（成功/失败、手动/自动/取消全量）。
    纯会话内存（runlog store，刷新即清）——本页只读 ring 与转发清空，
    排障正文（请求/响应全文）按行展开查看。
  -->
  <div class="tt-runlog">
    <div class="tt-runlog-head">
      <span class="tt-runlog-title">日志</span>
      <button type="button" class="tt-btn" :disabled="store.records.length === 0" @click="store.clear()">
        清空
      </button>
    </div>

    <div v-if="store.records.length === 0" class="tt-runlog-empty">
      尚无生成记录——成功与失败的生成都会记在这里（仅本会话，刷新即清）
    </div>
    <ul v-else class="tt-runlog-list">
      <li v-for="r in store.records" :key="r.id" class="tt-runlog-item">
        <button type="button" class="tt-runlog-row" :class="{ 'tt-runlog-row--fail': !r.ok }" @click="toggle(r.id)">
          <span class="tt-runlog-time">{{ formatTime(r.at) }}</span>
          <span class="tt-runlog-task">{{ r.task }}</span>
          <span class="tt-runlog-ok">{{ r.ok ? 'ok' : 'fail' }}</span>
          <span class="tt-runlog-model">{{ r.model }}</span>
          <span class="tt-runlog-detail">{{ detailText(r) }}</span>
          <span class="tt-runlog-dur">{{ formatDuration(r.durationMs) }}</span>
        </button>
        <div v-if="r.ok === false && r.error" class="tt-runlog-error">{{ r.error }}</div>
        <div v-if="expanded === r.id" class="tt-runlog-body">
          <button type="button" class="tt-btn" @click="copyRecord(r)">复制全文</button>
          <div class="tt-runlog-section">请求（{{ r.endpointUrl }} · {{ r.contract }} · {{ r.stream ? '流式' : '非流式' }}）</div>
          <pre class="tt-runlog-pre">{{ r.requestText }}</pre>
          <div class="tt-runlog-section">响应</div>
          <pre class="tt-runlog-pre">{{ r.responseText }}</pre>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRunlogStore } from '@/modules/runlog/store';
import type { RunRecord } from '@/modules/runlog/types';

const store = useRunlogStore();
const expanded = ref<number | null>(null);

function toggle(id: number): void {
    expanded.value = expanded.value === id ? null : id;
}

function formatTime(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('zh-CN', { hour12: false });
}

function formatDuration(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

function detailText(r: RunRecord): string {
    // choice 记录 enrich 后带解析路径与条数（partial 附丢弃数）；persona/未 enrich 记录无此段
    if (r.task !== 'choice' || r.parsePath === undefined) return '—';
    return r.dropped !== undefined
        ? `${r.parsePath} · ${r.optionCount ?? '?'} 条（丢 ${r.dropped}）`
        : `${r.parsePath} · ${r.optionCount ?? '?'} 条`;
}

function recordText(r: RunRecord): string {
    return [
        `run#${r.id} ${r.at} ${r.task} ${r.ok ? 'ok' : 'fail'}`,
        `端点 ${r.endpointUrl} 模型 ${r.model} 契约 ${r.contract} ${r.stream ? '流式' : '非流式'} 耗时 ${formatDuration(r.durationMs)}`,
        r.error ? `错误 ${r.error}` : '',
        `解析 ${r.parsePath ?? '—'} 条数 ${r.optionCount ?? '—'}${r.dropped !== undefined ? ` 丢弃 ${r.dropped}` : ''}`,
        '--- 请求 ---',
        r.requestText,
        '--- 响应 ---',
        r.responseText,
    ].filter(s => s !== '').join('\n');
}

async function copyRecord(r: RunRecord): Promise<void> {
    await navigator.clipboard.writeText(recordText(r));
}
</script>

<style scoped>
.tt-runlog {
    display: flex;
    flex-direction: column;
    gap: var(--tt-sp-2);
}

.tt-runlog-head {
    display: flex;
    align-items: center;
    gap: var(--tt-sp-2);
}

.tt-runlog-title {
    font-weight: bold;
    opacity: 0.85;
    user-select: none;
}

/* 头行清空钮靠右；.tt-btn 只管皮肤，布局挂容器 */
.tt-runlog-head > .tt-btn {
    margin-left: auto;
}

.tt-runlog-empty {
    font-size: var(--tt-fs-aux);
    opacity: 0.6;
    padding: var(--tt-sp-2) 0;
}

.tt-runlog-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--tt-sp-1);
    max-height: 60dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
}

.tt-runlog-item {
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 6px;
    padding: var(--tt-sp-1) var(--tt-sp-2);
}

/* 行即按钮特化形态：整行点击展开排障正文（保留，只走令牌） */
.tt-runlog-row {
    display: flex;
    align-items: baseline;
    gap: var(--tt-sp-2);
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: none;
    padding: var(--tt-sp-1) 0;
    font-size: var(--tt-fs-aux);
    cursor: pointer;
}

.tt-runlog-row:hover {
    filter: brightness(1.15);
}

.tt-runlog-row--fail .tt-runlog-ok {
    color: var(--SmartThemeQuoteColor, #c58a36);
}

.tt-runlog-time,
.tt-runlog-task,
.tt-runlog-ok {
    flex-shrink: 0;
    opacity: 0.75;
}

.tt-runlog-model {
    flex-shrink: 0;
    max-width: 16em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tt-runlog-detail {
    flex: 1;
    min-width: 0;
    opacity: 0.7;
}

.tt-runlog-dur {
    flex-shrink: 0;
    opacity: 0.75;
}

.tt-runlog-error {
    color: var(--SmartThemeQuoteColor, #c58a36);
    font-size: var(--tt-fs-hint);
    padding: var(--tt-sp-1) 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
}

.tt-runlog-body {
    border-top: 1px solid var(--SmartThemeBorderColor, #666);
    padding: var(--tt-sp-1) 0;
    display: flex;
    flex-direction: column;
    gap: var(--tt-sp-1);
}

.tt-runlog-body > .tt-btn {
    align-self: flex-end;
}

.tt-runlog-section {
    font-size: var(--tt-fs-hint);
    font-weight: bold;
    opacity: 0.7;
    user-select: none;
}

.tt-runlog-pre {
    margin: 0;
    padding: var(--tt-sp-1) var(--tt-sp-2);
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    border-radius: 4px;
    font-size: var(--tt-fs-hint);
    max-height: 12em;
    overflow-y: auto;
    /* 折行防线（choice-bar 同款）：pre-wrap 保留原文换行，anywhere 强制断长串 */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    user-select: text;
}
</style>
