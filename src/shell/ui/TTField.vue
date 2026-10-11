<template>
  <!--
    字段行布局原语：标签左、控件右一行。只负责布局归位（控件宽度撑满、
    去默认外边距）；控件皮肤一律来自控件自带的 .tt-ctrl 类（皮肤单点）。
  -->
  <label class="tt-ui-field">
    <span class="tt-ui-field-label">{{ label }}</span>
    <slot />
  </label>
</template>

<script setup lang="ts">
defineProps<{
    label: string;
}>();
</script>

<style scoped>
.tt-ui-field {
    display: flex;
    align-items: center;
    gap: var(--tt-sp-2);
    padding: var(--tt-sp-1) 0;
}

.tt-ui-field-label {
    min-width: 4em;
    opacity: 0.8;
    flex-shrink: 0;
    font-size: var(--tt-fs-aux);
}

.tt-ui-field :deep(select),
.tt-ui-field :deep(input),
.tt-ui-field :deep(textarea) {
    width: 100%;
    margin: 0;
}
</style>
