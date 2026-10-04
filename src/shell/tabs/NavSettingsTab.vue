<template>
  <div class="tt-nav-settings-tab">
    <div class="tt-card">
      <div class="tt-card-title">导航</div>
      <div class="tt-card-sub">消息回顶/上下文导航（/ttnav-* 命令与「tt-toolkit 导航」快速回复集）</div>
      <label class="tt-switch-row">
        <input type="checkbox" :checked="navStore.autoTop" @change="toggleAutoTop">
        <span>自动回顶（生成结束后跳回最新楼层）</span>
      </label>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useNavStore } from '@/modules/nav/store';

const navStore = useNavStore();

function toggleAutoTop(e: Event): void {
    navStore.setAutoTop((e.target as HTMLInputElement).checked);
}
</script>
