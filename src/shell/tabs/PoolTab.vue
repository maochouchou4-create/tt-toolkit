<template>
  <!--
    条目池 tab（只读浏览）：内容随插件仓库发布（default-pool.json 是唯一
    真相源，编辑走 git 更新链），本页无任何控制面——生成行为开关（每轮
    自动生成/按分类轮询）在「选项生成」页的生成参数卡。数据层不动，
    生成管线消费面零变化。
    视觉从简：卡片化＋SmartTheme 变量（复用壳的 .tt-card 体系；类名独立
    tt-pool- 前缀——样式块是全局的，与 ChoiceSettingsTab 的 tt-choice- 前缀
    互不干扰）。
  -->
  <div class="tt-pool-tab">
    <!-- 只读条目列表卡 -->
    <div class="tt-card">
      <div class="tt-card-title">条目池</div>
      <div class="tt-card-sub">
        共 {{ pool.masterPool.length }} 条 · {{ categoryCount }} 个分类。内容随插件更新发布，不在页面编辑。
      </div>

      <div v-if="!pool.masterPool.length" class="tt-pool-empty">
        池内容尚未载入（刷新页面重试）。
      </div>

      <div v-for="group in groupedEntries" :key="group.category" class="tt-pool-group">
        <div class="tt-pool-group-head">{{ group.category }}<span class="tt-pool-group-count">{{ group.entries.length }}</span></div>
        <div v-for="entry in group.entries" :key="entry.id">
          <div class="tt-pool-entry-row" @click="toggleExpand(entry)">
            <span class="tt-pool-entry-type">{{ entry.type || '（无标题）' }}</span>
            <span class="tt-pool-entry-content">{{ entry.content }}</span>
            <span class="tt-pool-entry-badges">
              <span v-if="entry.pinned" class="tt-pool-badge">固定</span>
            </span>
          </div>

          <div v-if="expandedId === entry.id" class="tt-pool-entry-editor">
            <div class="tt-pool-editor-title">{{ entry.type || '（无标题）' }}</div>
            <div class="tt-pool-entry-detail">{{ entry.content }}</div>
            <div class="tt-pool-note">
              分类：{{ entry.category.trim() || '未分类' }}{{ entry.pinned ? ' · 固定条目（每轮必发，不参与抽签）' : '' }}
            </div>
          </div>
        </div>
      </div>

      <!-- 池规则已删：反 OOC 要点并入提示词模板的写作规则，
           不再随池发布/独立注入 -->
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { usePoolStore } from '@/modules/choice/pool/store';
import type { PoolEntry } from '@/modules/choice/pool/types';

const pool = usePoolStore();

// ---- 只读列表 ----

const expandedId = ref('');

const categoryCount = computed(() => new Set(pool.masterPool.map(e => e.category.trim() || '未分类')).size);

const groupedEntries = computed(() => {
    // m03158 用户拍板：只读浏览不配搜索框（用不上）——全量分组直出
    const groups = new Map<string, PoolEntry[]>();
    for (const entry of pool.masterPool) {
        const key = entry.category.trim() || '未分类';
        const bucket = groups.get(key);
        if (bucket) bucket.push(entry);
        else groups.set(key, [entry]);
    }
    return [...groups.entries()].map(([category, entries]) => ({ category, entries }));
});

function toggleExpand(entry: PoolEntry) {
    expandedId.value = expandedId.value === entry.id ? '' : entry.id;
}
</script>

<style>
/* 条目池 tab（全局样式块，类名 tt-pool- 前缀与 tt-choice- 互不干扰；
   卡片壳复用壳层 .tt-card 体系） */
.tt-pool-tab {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.tt-pool-note {
    font-size: 0.75em;
    opacity: 0.6;
    padding: 0 0 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tt-pool-empty {
    font-size: 0.8em;
    opacity: 0.6;
    padding: 6px 0;
}

.tt-pool-group {
    margin-top: 6px;
}

.tt-pool-group-head {
    font-size: 0.8em;
    font-weight: bold;
    opacity: 0.85;
    padding: 4px 0 2px;
    border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #666) 60%, transparent);
    display: flex;
    align-items: baseline;
    gap: 6px;
}

.tt-pool-group-count {
    font-weight: normal;
    font-size: 0.85em;
    opacity: 0.6;
}

.tt-pool-entry-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 2px;
    cursor: pointer;
    border-bottom: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor, #666) 35%, transparent);
    min-width: 0;
}

.tt-pool-entry-row:hover {
    background: color-mix(in srgb, var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.2)) 60%, transparent);
}

.tt-pool-entry-type {
    font-weight: bold;
    font-size: 0.85em;
    white-space: nowrap;
    flex-shrink: 0;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
}

.tt-pool-entry-content {
    font-size: 0.8em;
    opacity: 0.75;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
}

.tt-pool-entry-badges {
    flex-shrink: 0;
}

.tt-pool-badge {
    font-size: 0.7em;
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 999px;
    padding: 1px 8px;
    opacity: 0.75;
    white-space: nowrap;
}

.tt-pool-entry-editor {
    border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #666) 50%, transparent);
    border-radius: 6px;
    padding: 8px;
    margin: 4px 0 8px;
    background: color-mix(in srgb, var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.15)) 50%, transparent);
}

.tt-pool-editor-title {
    font-size: 0.78em;
    font-weight: bold;
    opacity: 0.8;
    margin: 4px 0;
}

.tt-pool-entry-detail {
    font-size: 0.82em;
    opacity: 0.85;
    margin: 2px 0 6px;
    line-height: 1.5;
}
</style>
