<template>
  <!--
    聊天选项条：选项渲染、点击行为（填入/追加/发送）、生成
    按钮。选项＝「当前楼层」的选项：持久化在消息 extra（随宿主聊天
    文件落盘），切楼层/切聊天按楼层装载，无存档显示空态。
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
    <!-- 错误条与旧列表并存（双复核 P3 修复）：失败时旧选项数据仍在 store
         里，顶替渲染会让可用选项不可见不可点——错误条只追加在头部下方 -->
    <div v-if="store.phase === 'error'" class="tt-choice-bar-error" :title="store.error">{{ store.error }}</div>
    <div v-if="store.options.length === 0" class="tt-choice-bar-empty">
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
import { applyOption, cancelGeneration, generateOptions, isGenerating } from './generator';
import { useChoiceSettingsStore } from './settings';
import { useChoiceStore } from './store';

const store = useChoiceStore();
const settings = useChoiceSettingsStore();

const behaviorHint = computed(() => {
    // storage 域是宿主的非响应式对象，直接读 choiceStorage 计算后不会失效
    // （改了点击行为，悬停提示仍是旧文案）——走 settings store 的读透传
    // getter（nav store revision 同款失效信号：写方 bump、getter 重算）
    const behavior = settings.gen.clickBehavior;
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
    // 回退解析＝宽松解析安全网，细节留在日志 tab
    if (store.lastParsePath === 'bracket_fallback') return '模型输出不合 JSON 约定时的宽松解析安全网（详见日志 tab）';
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
