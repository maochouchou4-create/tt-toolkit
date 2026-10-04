<template>
  <!--
    壳浮层：根元素复用宿主 .drawer-content 皮肤（#floatingPrompt 先例，
    实证宿主渲染正常），openDrawer 为显示态。头行布局完全自持
    （.tt-shell-controlbar）：不得复用宿主 .panelControlBar ——宿主
    body .panelControlBar（style.css:879-888）是 position:absolute 的
    右上角图标簇（原生浮层里只放把手/关闭等图标，index.html:8039-8045），
    塞标题进去会被钉在浮层右上角压住正文（用户验收实测「标题行消失＋
    显示乱飞」根因）。拖把手 id 必须是 <根id>header 且带 .drag-grabber
    类（宿主 dragElement 契约）；图标用 Unicode 文本渲染——宿主
    FontAwesome 字形在本扩展实测未渲染（空 div 零宽＝不可见不可抓），
    不依赖字体才稳。
  -->
  <div id="ttToolkitShell" class="drawer-content flexGap5 tt-shell" :class="{ openDrawer: store.open }">
    <div class="tt-shell-controlbar">
      <div id="ttToolkitShellheader" class="drag-grabber tt-shell-grabber" title="拖动">⠿</div>
      <b class="tt-shell-title">TT 工具箱</b>
      <span class="tt-shell-version">v{{ version }}</span>
      <div class="tt-shell-close" title="收起" @click="store.toggle(false)">✕</div>
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
import { attachHostDrag, getSavedMovingUIState } from '@/host';
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
    // 拖动位置自恢复：dragElement 把位置写进宿主 movingUIState，但宿主的
    // 恢复流程先于扩展挂载、覆盖不到本元素——挂载时自行读回套用。
    // 只取 top/left/width/height：宿主的全字段套用会同时设 top+bottom 把
    // 自适应高度的浮层拉伸变形（.tt-shell 无定高），right/bottom 有意不取
    const el = document.getElementById('ttToolkitShell');
    const saved = getSavedMovingUIState('ttToolkitShell');
    if (el && saved) {
        if (typeof saved.top === 'number') el.style.top = `${saved.top}px`;
        if (typeof saved.left === 'number') el.style.left = `${saved.left}px`;
        if (typeof saved.width === 'number') el.style.width = `${saved.width}px`;
        if (typeof saved.height === 'number') el.style.height = `${saved.height}px`;
        if (saved.margin) el.style.margin = saved.margin;
    }
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
