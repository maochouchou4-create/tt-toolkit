<template>
  <!--
    聊天选项条（方案 §2.4）：选项渲染、点击行为（填入/追加/发送）、生成
    按钮。会话内存态（不持久化，切聊天/刷新即清空——消息级持久化归批C）。
    视觉从简：卡片化＋SmartTheme 变量（与壳同体系）。
  -->
  <div id="ttChoiceBar" class="tt-choice-bar">
    <div class="tt-choice-bar-head">
      <span class="tt-choice-bar-title">行动选项</span>
      <span v-if="parsePathLabel" class="tt-choice-bar-parse" :title="parsePathLabelTitle">{{ parsePathLabel }}</span>
      <button
        type="button"
        class="tt-choice-bar-gen"
        :class="{ 'tt-choice-bar-gen--cancel': store.phase === 'running' }"
        @click="onGenerateClick"
      >
        {{ store.phase === 'running' ? '取消' : '生成选项' }}
      </button>
    </div>
    <div v-if="store.phase === 'error'" class="tt-choice-bar-error" :title="store.error">{{ store.error }}</div>
    <div v-else-if="store.options.length === 0" class="tt-choice-bar-empty">
      {{ store.phase === 'running' ? '正在生成…' : '尚无选项——点击「生成选项」基于当前剧情生成' }}
    </div>
    <ul v-else class="tt-choice-list">
      <li v-for="(opt, i) in store.options" :key="`${i}-${opt.title}-${opt.content.slice(0, 12)}`">
        <button type="button" class="tt-choice-option" :title="behaviorHint" @click="onOptionClick(opt)">
          <span v-if="opt.title" class="tt-choice-option-title">{{ opt.title }}</span>
          <span class="tt-choice-option-content">{{ opt.content }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { choiceStorage } from './api';
import { applyOption, cancelGeneration, generateOptions, isGenerating } from './generator';
import { useChoiceStore } from './store';

const store = useChoiceStore();

const behaviorHint = computed(() => {
    const behavior = choiceStorage.readDomain().gen.clickBehavior;
    if (behavior === 'send') return '点击后直接发送';
    if (behavior === 'append') return '点击后追加到输入框末尾';
    return '点击后填入输入框（可编辑后手动发送）';
});

const parsePathLabel = computed(() => {
    if (!store.lastParsePath) return '';
    if (store.lastParsePath === 'json') return 'JSON 契约';
    if (store.lastParsePath === 'bracket_fallback') return '回退解析';
    return '';
});

const parsePathLabelTitle = computed(() => {
    if (store.lastParsePath === 'bracket_fallback') return '结构化输出未命中/解析失败，已走括号格式回退解析';
    if (store.lastParsePath === 'json') return '模型输出符合 JSON 契约';
    return '';
});

function onGenerateClick(): void {
    // 运行中点击＝取消（长请求逃生：GG 类假流式端点可能久挂）
    if (isGenerating()) {
        cancelGeneration();
        return;
    }
    void generateOptions();
}

function onOptionClick(opt: { title: string; content: string }): void {
    applyOption(opt.content);
}
</script>

<style src="./choice-bar.css"></style>
