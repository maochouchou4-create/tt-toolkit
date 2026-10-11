<template>
  <!--
    卡片容器原语：tab 页分组容器的唯一形态。视觉完全 scoped 自持
    （壳层全局 .tt-card* 是其余 tab 的过渡期样式，批 2 收编删除）；
    规格级长文走 details slot 折叠，不铺在设置面。
  -->
  <section class="tt-ui-card">
    <div class="tt-ui-card-title">{{ title }}</div>
    <div v-if="sub" class="tt-ui-card-sub">{{ sub }}</div>
    <details v-if="$slots.details" class="tt-ui-card-details">
      <summary>详细说明</summary>
      <div class="tt-ui-card-details-body"><slot name="details" /></div>
    </details>
    <slot />
  </section>
</template>

<script setup lang="ts">
defineProps<{
    title: string;
    sub?: string;
}>();
</script>

<style scoped>
.tt-ui-card {
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 8px;
    padding: var(--tt-sp-2) var(--tt-sp-3);
    margin-bottom: var(--tt-sp-2);
    background: var(--SmartThemeChatTintColor, transparent);
}

.tt-ui-card-title {
    font-weight: bold;
    margin-bottom: var(--tt-sp-2);
    user-select: none;
}

.tt-ui-card-sub {
    font-size: var(--tt-fs-hint);
    opacity: 0.65;
    margin-bottom: var(--tt-sp-2);
}

.tt-ui-card-details {
    font-size: var(--tt-fs-hint);
    opacity: 0.65;
    margin-bottom: var(--tt-sp-2);
}

.tt-ui-card-details summary {
    cursor: pointer;
    user-select: none;
}

.tt-ui-card-details-body {
    padding-top: var(--tt-sp-1);
}
</style>
