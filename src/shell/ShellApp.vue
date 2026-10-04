<template>
  <!--
    壳浮层：复用宿主 drawer-content 体系（#floatingPrompt 先例）——配色/
    毛玻璃/边框来自宿主 .drawer-content（SmartTheme 变量），openDrawer
    为显示态。拖把手 id 必须是 <根id>header（宿主 dragElement 契约）。
  -->
  <div id="ttToolkitShell" class="drawer-content flexGap5 tt-shell" :class="{ openDrawer: store.open }">
    <div class="panelControlBar flex-container alignItemsBaseline">
      <div id="ttToolkitShellheader" class="fa-fw fa-solid fa-grip drag-grabber" title="拖动" />
      <b class="tt-shell-title">TT 工具箱</b>
      <span class="tt-shell-version">v{{ version }}</span>
      <div class="tt-shell-close fa-fw fa-solid fa-circle-xmark floating_panel_close" title="收起" @click="store.toggle(false)" />
    </div>
    <div class="tt-shell-body">
      <div v-if="store.tabs.length === 0" class="tt-shell-empty">没有可用的功能页（模块未注册任何 tab）</div>
      <template v-else>
        <div class="tt-tab-strip" role="tablist">
          <button
            v-for="tab in store.tabs"
            :key="tab.id"
            type="button"
            role="tab"
            class="tt-tab-button"
            :class="{ 'tt-tab-button--active': store.activeTabId === tab.id }"
            @click="store.activate(tab.id)"
          >
            {{ tab.tabTitle }}
          </button>
        </div>
        <div ref="tabHost" class="tt-tab-host scrollY" />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { attachHostDrag } from '@/host';
import { version } from '@/version';
import { useShellStore } from './store';
import type { ShellTab } from './types';

const store = useShellStore();
const tabHost = ref<HTMLElement | null>(null);

// 每个 tab 一个专属容器（保持挂载、切换可见性）：mount 契约只在
// 首次激活时执行一次，编辑态跨 tab 切换不丢
const mountedTabs = new Map<string, HTMLElement>();
let dragAttached = false;

function ensureTabContainer(tab: ShellTab): HTMLElement {
    let container = mountedTabs.get(tab.id);
    if (container) return container;
    container = document.createElement('div');
    container.className = 'tt-tab-container';
    container.dataset.tabId = tab.id;
    mountedTabs.set(tab.id, container);
    tabHost.value?.appendChild(container);
    try {
        tab.mount(container);
    } catch (e) {
        container.textContent = `功能页「${tab.tabTitle}」挂载失败：${e instanceof Error ? e.message : String(e)}`;
        console.error(`[tt-toolkit][shell] tab ${tab.id} mount 失败`, e);
    }
    return container;
}

function syncActiveTab(): void {
    if (!tabHost.value) return;
    const active = store.activeTab;
    if (!active) return;
    const container = ensureTabContainer(active);
    for (const el of Array.from(tabHost.value.children) as HTMLElement[]) {
        el.classList.toggle('tt-tab-container--visible', el === container);
    }
    active.onActivate?.();
}

onMounted(() => {
    dragAttached = attachHostDrag('ttToolkitShell');
    if (!dragAttached) console.warn('[tt-toolkit][shell] 宿主 dragElement 不可用，浮层不可拖动（功能不受影响）');
});

// tab 内容延迟到浮层首次打开才挂载（未打开时零初始化开销）
watch(
    () => store.open,
    opened => {
        if (opened) syncActiveTab();
    },
);

watch(
    () => store.activeTabId,
    () => {
        if (store.open) syncActiveTab();
    },
);

// 浮层 DOM 归壳 app 所有；组件卸载即整棵移除（扩展生命周期终点）
onBeforeUnmount(() => {
    mountedTabs.clear();
});
</script>

<style src="./shell.css"></style>
