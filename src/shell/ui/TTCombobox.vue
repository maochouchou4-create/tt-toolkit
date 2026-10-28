<script lang="ts">
// 弹层/选项 id 前缀用模块级计数：ARIA 关联要求多实例 id 唯一
let uid = 0;
</script>

<template>
  <!--
    可输可选单控件原语：输入即值本体，右侧钮开合候选浮层。
    开浮层（钮/方向键）＝浏览意图：候选从全表起步、激活项落当前值；键入才转过滤意图。
    弹层 Teleport 到 body：一是 .tt-tab-host 是滚动容器，宿内弹层会被裁剪
    或撑出滚动区；二是宿主给 .drawer-content（壳复用的类）设了
    backdrop-filter，带它的祖先会成为 fixed 后代的包含块——壳内弹层的
    fixed 会锚到壳自身坐标系而 viewport 坐标全部错位（真机实测：浮层开
    了但落在面板外）。body 直挂对宿主任何主题层的 transform/filter 免疫。
    外部 attrs（如 aria-label）经 $attrs 落到输入框——可访问性属性归输入框。
  -->
  <div ref="rootRef" class="tt-combobox">
    <input
      ref="inputRef"
      v-bind="$attrs"
      type="text"
      class="tt-ctrl tt-combobox-input"
      role="combobox"
      autocomplete="off"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      :placeholder="placeholder"
      :disabled="disabled"
      :tabindex="disabled ? -1 : 0"
      :aria-expanded="open"
      :aria-controls="open ? listboxId : undefined"
      :aria-activedescendant="open && activeIndex >= 0 ? optionId(activeIndex) : undefined"
      @input="onInput"
      @keydown="onKeydown"
      @compositionstart="composing = true"
      @compositionend="composing = false"
      @blur="onBlur"
    >
    <button
      type="button"
      class="tt-btn tt-combobox-toggle"
      aria-label="展开候选列表"
      :disabled="disabled"
      :aria-disabled="disabled"
      :tabindex="disabled ? -1 : 0"
      @mousedown.prevent
      @click="toggle"
    >▾</button>
    <Teleport v-if="open" to="body">
      <div
        ref="popupRef"
        :id="listboxId"
        class="tt-combobox-popup"
        role="listbox"
        aria-label="候选列表"
        :style="popupStyle"
      >
        <div v-if="filtered.length === 0" class="tt-combobox-empty">{{ emptyText ?? '无匹配项' }}</div>
        <template v-else>
          <div
            v-for="(option, index) in filtered"
            :key="`${index}-${option}`"
            :id="optionId(index)"
            class="tt-combobox-option"
            :class="{ 'tt-combobox-option--active': index === activeIndex }"
            role="option"
            :aria-selected="index === activeIndex"
            @mousemove="activeIndex = index"
            @mousedown.prevent="select(option)"
          >{{ option }}</div>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { matchesOption } from './filter';

const props = defineProps<{
    modelValue: string;
    options: readonly string[];
    placeholder?: string;
    disabled?: boolean;
    emptyText?: string;
}>();

const emit = defineEmits<{
    'update:modelValue': [value: string];
}>();

// aria-label 等外部 attrs 归输入框，不落根 div
defineOptions({ inheritAttrs: false });

const rootRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const popupRef = ref<HTMLElement | null>(null);

const listboxId = `tt-combobox-listbox-${++uid}`;

const open = ref(false);
const activeIndex = ref(-1);
const composing = ref(false);
const popupStyle = ref<Record<string, string>>({});
/** 过滤针：只认本次浮层会话内用户实际键入的文本——开浮层≠过滤（openPopup 重置）。 */
const query = ref('');

const filtered = computed(() => props.options.filter(option => matchesOption(option, query.value)));

/** 激活项落位：当前值在候选表内则续览当前值，否则回首项；空表无激活。 */
function resetActive(): void {
    const current = filtered.value.indexOf(props.modelValue);
    activeIndex.value = current >= 0 ? current : (filtered.value.length > 0 ? 0 : -1);
}

watch(filtered, () => {
    resetActive();
});

watch(() => props.disabled, disabled => {
    if (disabled) close();
});

// 外部换值（如换服务商清模型）：聚焦期间手填不被覆盖（契约①），失焦即收敛
watch(() => props.modelValue, value => {
    const input = inputRef.value;
    if (!input || document.activeElement === input) return;
    setInputValue(value);
});

watch(activeIndex, index => {
    if (!open.value || index < 0) return;
    nextTick(() => {
        document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' });
    });
});

watch(open, value => {
    setGlobalListeners(value);
});

onMounted(() => {
    setInputValue(props.modelValue);
});

onBeforeUnmount(() => {
    setGlobalListeners(false);
});

function optionId(index: number): string {
    return `${listboxId}-opt-${index}`;
}

function setInputValue(value: string): void {
    query.value = value;
    if (inputRef.value) inputRef.value.value = value;
}

function onInput(): void {
    const input = inputRef.value;
    if (!input) return;
    query.value = input.value;
    emit('update:modelValue', input.value);
}

function onKeydown(event: KeyboardEvent): void {
    if (composing.value) {
        // 组词期 Enter/Escape 归输入法（确认候选/取消组词），不进导航分支；
        // 但要拦冒泡——宿主全局快捷键（Enter 发送等）不得抢组词键
        event.stopPropagation();
        return;
    }
    switch (event.key) {
        case 'ArrowDown':
            event.preventDefault();
            if (open.value) move(1); else openPopup();
            break;
        case 'ArrowUp':
            event.preventDefault();
            if (open.value) move(-1); else openPopup();
            break;
        case 'Home':
            if (open.value) {
                event.preventDefault();
                activeIndex.value = 0;
            }
            break;
        case 'End':
            if (open.value) {
                event.preventDefault();
                activeIndex.value = filtered.value.length - 1;
            }
            break;
        case 'Enter':
            if (open.value) {
                // 拦截冒泡：壳开着时防宿主全局 Enter 快捷键误触
                event.preventDefault();
                event.stopPropagation();
                const option = filtered.value[activeIndex.value];
                if (option !== undefined) select(option);
                else close();
            }
            break;
        case 'Escape':
            if (open.value) {
                event.preventDefault();
                event.stopPropagation();
                close();
            }
            break;
        case 'Tab':
            close();
            break;
    }
}

function move(delta: number): void {
    const last = filtered.value.length - 1;
    if (last < 0) return;
    activeIndex.value = Math.min(last, Math.max(0, activeIndex.value + delta));
}

function toggle(): void {
    if (open.value) close();
    else openPopup();
}

function openPopup(): void {
    if (props.disabled) return;
    // 开浮层＝浏览意图：针清空显全表，激活项落当前值（过滤只认会话内键入）
    query.value = '';
    open.value = true;
    resetActive();
    positionPopup();
    nextTick(flipPopupIfClipped);
}

function select(option: string): void {
    setInputValue(option);
    emit('update:modelValue', option);
    close();
}

function close(): void {
    open.value = false;
}

function onBlur(): void {
    // 失焦收敛显示为落档值（消费方处理器可能 trim 过）
    const input = inputRef.value;
    if (input) input.value = props.modelValue;
    query.value = props.modelValue;
}

function positionPopup(): void {
    const root = rootRef.value;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    popupStyle.value = {
        left: `${Math.round(rect.left)}px`,
        minWidth: `${Math.round(rect.width)}px`,
        top: `${Math.round(rect.bottom + 4)}px`,
    };
}

/** 下方放不下且上方放得下时翻转到触发器上方展开。 */
function flipPopupIfClipped(): void {
    const root = rootRef.value;
    const popup = popupRef.value;
    if (!root || !popup) return;
    const rect = root.getBoundingClientRect();
    const height = popup.offsetHeight;
    if (rect.bottom + 4 + height > window.innerHeight && rect.top - 4 - height >= 0) {
        popupStyle.value = {
            ...popupStyle.value,
            top: 'auto',
            bottom: `${Math.round(window.innerHeight - rect.top + 4)}px`,
        };
    }
}

function onDocPointerDown(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) {
        close();
        return;
    }
    if (rootRef.value?.contains(target) || popupRef.value?.contains(target)) return;
    close();
}

function onDocScroll(event: Event): void {
    // 浮层自身滚动（长列表滚轮浏览）不收起——收起语义只针对页面/宿主滚动
    // 与窗口缩放（fixed 弹层不随滚动跟随，位置失真即收；resize 的 target
    // 是 window 非 Node，走 contains 会抛 TypeError，故非 Node 一律收）
    const target = event.target;
    if (target instanceof Node && popupRef.value?.contains(target)) return;
    close();
}

function setGlobalListeners(on: boolean): void {
    if (on) {
        document.addEventListener('pointerdown', onDocPointerDown);
        document.addEventListener('scroll', onDocScroll, true);
        window.addEventListener('resize', onDocScroll);
    } else {
        document.removeEventListener('pointerdown', onDocPointerDown);
        document.removeEventListener('scroll', onDocScroll, true);
        window.removeEventListener('resize', onDocScroll);
    }
}
</script>

<style scoped>
.tt-combobox {
    display: flex;
    align-items: center;
    gap: var(--tt-sp-1);
    min-width: 0;
}

.tt-combobox-input {
    flex: 1;
    min-width: 0;
}

.tt-combobox-toggle {
    flex-shrink: 0;
    width: 2em;
    padding: 0;
}

.tt-combobox-popup {
    position: fixed;
    /* 层级走全局单源 --tt-z-popup（shell.css :root，壳内浮层单源）：
       挂 body 须越过宿主 #movingDivs>div 的 4000 层叠上下文（工具箱壳
       深处其中），压壳自身的 30000 一头 */
    z-index: var(--tt-z-popup);
    max-height: 240px;
    overflow-y: auto;
    /* 滚动到边界不再链传页面：链传会被 onDocScroll 判成宿主滚动而收起浮层 */
    overscroll-behavior: contain;
    background: var(--SmartThemeChatTintColor, rgba(42, 42, 46, 0.98));
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
    /* 挂 body 后脱离 .tt-shell 的令牌继承域，兜底值与令牌定义同值
       （em 兜底对 body 字号解析，与壳根继承链同源） */
    padding: var(--tt-sp-1, 4px) 0;
}

.tt-combobox-option {
    padding: var(--tt-sp-1, 4px) var(--tt-sp-2, 8px);
    cursor: pointer;
}

.tt-combobox-option--active {
    filter: brightness(1.2);
}

.tt-combobox-empty {
    padding: var(--tt-sp-1, 4px) var(--tt-sp-2, 8px);
    font-size: var(--tt-fs-hint, 0.75em);
    opacity: 0.65;
}
</style>
