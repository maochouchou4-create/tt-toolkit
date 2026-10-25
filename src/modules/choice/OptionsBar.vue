<template>
  <!--
    行动选项托盘：常驻面只剩输入区图标槽里的触发钮（宿主
    #leftSendForm>div 规则自动取皮，本组件不自绘尺寸/皮肤），托盘浮层
    Teleport 到 body——#send_form 的 backdrop-filter 会劫持原位 fixed 的
    包含块（TTCombobox.vue 同款实证），挂 body 免疫。选项＝「当前楼层」
    的选项：持久化在消息 extra（随宿主聊天文件落盘），切楼层/切聊天按
    楼层装载，无存档显示空态。
  -->
  <div id="ttChoiceTray"></div>
  <Teleport to="#leftSendForm">
    <div
      ref="triggerRef"
      class="tt-choice-trigger"
      :class="{ 'is-running': store.phase === 'running', 'is-error': store.phase === 'error' }"
      :title="triggerTitle"
      @click="toggleTray"
    >✦</div>
  </Teleport>
  <Teleport to="body">
    <div v-if="open" ref="trayRef" class="tt-choice-tray" :style="popupStyle">
      <div v-if="store.phase === 'error'" class="tt-choice-tray-error" :title="store.error">{{ store.error }}</div>
      <div v-if="store.phase === 'running'" class="tt-choice-tray-empty">正在生成…</div>
      <div v-else-if="store.options.length === 0" class="tt-choice-tray-empty">尚无选项</div>
      <div v-else class="tt-choice-grid">
        <button
          v-for="(opt, i) in store.options"
          :key="`${i}-${opt.title}-${opt.content.slice(0, 12)}`"
          type="button"
          class="tt-choice-option"
          :title="behaviorHint"
          @click="onOptionClick(opt)"
        >
          <span v-if="opt.title" class="tt-choice-option-title">{{ opt.title }}</span>
          <span class="tt-choice-option-content">{{ opt.content }}</span>
          <span v-if="opt.aim" class="tt-choice-option-aim">{{ opt.aim }}</span>
        </button>
      </div>
      <div class="tt-choice-tray-foot">
        <button
          type="button"
          class="tt-choice-bar-gen"
          :class="{ 'tt-choice-bar-gen--cancel': store.phase === 'running' }"
          @click="onGenerateClick"
        >
          {{ store.phase === 'running' ? '取消' : '生成选项' }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { applyOption, cancelGeneration, generateOptions, isGenerating } from './generator';
import type { ParsedOption } from './parse';
import { useChoiceSettingsStore } from './settings';
import { useChoiceStore } from './store';

const store = useChoiceStore();
const settings = useChoiceSettingsStore();

const triggerRef = ref<HTMLElement | null>(null);
const trayRef = ref<HTMLElement | null>(null);
const open = ref(false);
const popupStyle = ref<Record<string, string>>({});

const behaviorHint = computed(() => {
    // storage 域是宿主的非响应式对象，直接读 choiceStorage 计算后不会失效
    // （改了点击行为，悬停提示仍是旧文案）——走 settings store 的读透传
    // getter（nav store revision 同款失效信号：写方 bump、getter 重算）
    const behavior = settings.gen.clickBehavior;
    if (behavior === 'send') return '点击后直接发送';
    if (behavior === 'append') return '点击后追加到输入框末尾';
    return '点击后填入输入框（可编辑后手动发送）';
});

// 触发钮状态灯：自动生成全程托盘关闭时，running/error 的可见性由常驻
// 触发钮承担（脉动/错误色在 CSS 状态类，详情与取消入口在托盘内）
const triggerTitle = computed(() => {
    if (store.phase === 'running') return '正在生成选项…';
    if (store.phase === 'error') return store.error;
    return '行动选项';
});

/**
 * 定位＝主锚 #send_form 实测 rect（left/width 随输入区、bottom 恒向上
 * 展开、不翻转）。探测锚 #leftSendForm 与定位锚 #send_form 是两个宿主
 * 锚点，等待只 gate 探测锚——定位锚失效走显式回退（触发钮自身 rect，
 * 宽度退化），不静默错位。
 */
function positionTray(): void {
    const form = document.querySelector('#send_form');
    let rect: DOMRect;
    if (form) {
        rect = form.getBoundingClientRect();
    } else {
        console.warn('[tt-toolkit][choice] #send_form 缺席，托盘回退触发钮自身定位');
        const trigger = triggerRef.value;
        if (!trigger) return;
        rect = trigger.getBoundingClientRect();
    }
    popupStyle.value = {
        left: `${Math.round(rect.left)}px`,
        width: `${Math.round(rect.width)}px`,
        bottom: `${Math.round(window.innerHeight - rect.top + 4)}px`,
    };
}

function openTray(): void {
    positionTray();
    open.value = true;
}

function close(): void {
    open.value = false;
}

function toggleTray(): void {
    if (open.value) close();
    else openTray();
}

// 自动展开只认「新一次生成成功」（running→idle）——切楼层/切聊天装载走
// restore/syncToFloor，不过 phase，天然不弹；generator 空结果即 throw，
// succeed 必带 ≥1 条，无需判空
watch(() => store.phase, (val, old) => {
    if (old === 'running' && val === 'idle') openTray();
});

function onGenerateClick(): void {
    // 运行中点击＝取消（长请求逃生：GG 类假流式端点可能久挂）
    if (isGenerating()) {
        cancelGeneration();
        return;
    }
    void generateOptions();
}

function onOptionClick(opt: ParsedOption): void {
    // aim 属显示与存档面，不参与点击应用：主聊天里出现「想撬动什么」是
    // 对外契约破坏——主模型无从解释这句写给玩家看的元信息
    applyOption(opt.content);
    close();
}

// 收起监听随开挂随合摘。比 TTCombobox 先例少一路 scroll 收起：主锚
// #send_form 是宿主静态骨架、对视口静止，聊天滚动不使托盘错位
function onDocPointerDown(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) {
        close();
        return;
    }
    if (triggerRef.value?.contains(target) || trayRef.value?.contains(target)) return;
    close();
}

function onDocKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Escape') close();
}

function setGlobalListeners(on: boolean): void {
    if (on) {
        document.addEventListener('pointerdown', onDocPointerDown);
        document.addEventListener('keydown', onDocKeydown);
        window.addEventListener('resize', close);
    } else {
        document.removeEventListener('pointerdown', onDocPointerDown);
        document.removeEventListener('keydown', onDocKeydown);
        window.removeEventListener('resize', close);
    }
}

watch(open, setGlobalListeners);

onBeforeUnmount(() => {
    setGlobalListeners(false);
});
</script>

<style src="./choice-bar.css"></style>
