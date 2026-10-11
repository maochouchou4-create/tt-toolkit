<template>
  <!--
    状态文字原语：行内徽标/提示。muted＝默认字色弱提示；ok/err＝成功/危险
    语义色；warn 预留。
  -->
  <span class="tt-ui-status" :data-tone="tone"><slot /></span>
</template>

<script setup lang="ts">
defineProps<{
    tone: 'muted' | 'ok' | 'warn' | 'err';
}>();
</script>

<style scoped>
.tt-ui-status {
    font-size: var(--tt-fs-hint);
    opacity: 0.9;
}

.tt-ui-status[data-tone='ok'] {
    color: var(--SmartThemeQuoteColor, #4b8b5f);
}

.tt-ui-status[data-tone='warn'] {
    color: var(--SmartThemeFontColorWarning, #b5a04b);
}

.tt-ui-status[data-tone='err'] {
    color: var(--SmartThemeFontColorDanger, #b54b4b);
}
</style>
