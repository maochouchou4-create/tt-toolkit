<template>
  <!--
    提示词编辑器（G5 信息架构＋m03359 整合轮）：顶部白话说明＋四段——
    ①核心模板（文本模块，单模板无配置集——用户拍板「懒得配置」；改坏
    可「恢复默认」一键回厂）②剧情走向（从「选项生成」tab 挪入：走向
    是提示词素材，编辑入口应在同一页）③上下文注入（现场数据开关＋
    每项说明）④高级（外部插件内容搬运）。dump/trace 类调试面收进
    调试 tab，主编辑面不出现。单一真相源：直接编辑当前生效模板的
    modules[]（无工作副本——fork 双真相源病不继承）。
  -->
  <div class="tt-prompt-editor-tab">
    <div class="tt-prompt-intro">
      这里编辑的是选项生成时发给 AI 的完整指令模板——改任何一块，下一次生成就生效。
    </div>

    <div class="tt-prompt-section-title">核心模板</div>
    <div v-if="effective" class="tt-card">
      <div class="tt-card-title">指令文本</div>
      <div class="tt-card-sub">
        任务、示例、写作规则、输出格式这类可改写的指令文本。勾选＝参与组装，点「编辑」改正文；
        改坏了点下方「恢复默认模板」一键回厂。
      </div>
      <div
        v-for="mod in textModules"
        :key="mod.id"
        class="tt-prompt-module"
        :class="{ 'tt-prompt-module--disabled': !mod.enabled }"
      >
        <div class="tt-prompt-module-head">
          <label class="tt-prompt-module-toggle" :title="mod.enabled ? '点击停用' : '点击启用'">
            <input type="checkbox" :checked="mod.enabled" @change="prompts.toggleModule(mod.id, ($event.target as HTMLInputElement).checked)">
            <span>{{ mod.name }}</span>
          </label>
          <!-- 角色不设下拉：system/user 是消息内部概念，由引擎按默认模板固定。
               旧版（fork）同样不暴露此字段，用户实测无需可调。 -->
          <span class="tt-prompt-module-ops">
            <button type="button" title="上移" :disabled="isFirst(mod)" @click="prompts.moveModule(mod.id, -1)">↑</button>
            <button type="button" title="下移" :disabled="isLast(mod)" @click="prompts.moveModule(mod.id, 1)">↓</button>
            <button type="button" @click="toggleEdit(mod)">{{ editingId === mod.id ? '收起' : '编辑' }}</button>
          </span>
        </div>
        <textarea
          v-if="editingId === mod.id"
          class="tt-prompt-module-editor"
          :value="mod.content"
          rows="10"
          spellcheck="false"
          @change="prompts.updateModuleContent(mod.id, ($event.target as HTMLTextAreaElement).value)"
        />
      </div>
      <div class="tt-actions" style="margin-top: 6px">
        <button type="button" class="tt-prompt-reset-btn" @click="resetTemplate">恢复默认模板</button>
      </div>
    </div>

    <div class="tt-prompt-section-title">剧情走向</div>
    <div class="tt-card">
      <div class="tt-card-title">走向指引</div>
      <div class="tt-card-sub">
        走向答「剧情往哪走」：写一两句话告诉 AI 这轮剧情往哪个方向推进（随当前聊天保存）；
        留空＝不注入走向。
      </div>
      <label class="tt-prompt-field--block">
        <span>自由文本（主位）</span>
        <textarea
          :value="prompts.storyDirection.freeText"
          rows="3"
          placeholder="如：让林霜主动坦白昨夜去向的真相，并暴露她与斗篷人的旧关联"
          @input="onDirectionTextInput"
        />
      </label>
      <div class="tt-prompt-presets">
        <div class="tt-prompt-presets-head">
          <span>我的预设</span>
          <button type="button" :disabled="!prompts.storyDirection.freeText.trim()" title="把当前走向指引文本存为预设（全局保存，所有聊天可用）" @click="saveCurrentTextAsPreset">存为预设</button>
        </div>
        <div v-if="prompts.directionPresets.length === 0" class="tt-prompt-empty">
          还没有预设——写好走向指引后点「存为预设」，以后一条点击应用
        </div>
        <div v-else class="tt-prompt-tags">
          <button
            v-for="preset in prompts.directionPresets"
            :key="preset.id"
            type="button"
            class="tt-prompt-tag"
            :class="{ 'tt-prompt-tag--active': prompts.storyDirection.presetText === preset.text }"
            :title="preset.text"
            @click="togglePreset(preset)"
          >
            {{ presetLabel(preset) }}
            <span class="tt-prompt-tag-del" title="删除该预设（不影响已应用的聊天）" @click.stop="removePreset(preset)">×</span>
          </button>
        </div>
        <div v-if="prompts.storyDirection.presetText" class="tt-prompt-note">
          已应用预设：{{ prompts.storyDirection.presetText }}（再点同一预设可取消应用）
        </div>
      </div>
    </div>

    <div class="tt-prompt-section-title">上下文注入</div>
    <div v-if="effective" class="tt-card">
      <div class="tt-card-sub">
        这些开关决定把哪些现场信息带给生成选项的 AI：勾选＝注入，取消＝不带。
      </div>
      <div
        v-for="mod in contextModules"
        :key="mod.id"
        class="tt-prompt-module"
        :class="{ 'tt-prompt-module--disabled': !mod.enabled }"
      >
        <div class="tt-prompt-module-head">
          <label class="tt-prompt-module-toggle" :title="mod.enabled ? '点击停用' : '点击启用'">
            <input type="checkbox" :checked="mod.enabled" @change="prompts.toggleModule(mod.id, ($event.target as HTMLInputElement).checked)">
            <span>{{ mod.name }}</span>
          </label>
          <!-- chat_history 的楼层角色由聊天本身决定（user/assistant）；
               其余注入模块角色由引擎固定。UI 不暴露角色概念（旧版同样如此）。 -->
          <span class="tt-prompt-module-ops">
            <button type="button" title="上移" :disabled="isFirst(mod)" @click="prompts.moveModule(mod.id, -1)">↑</button>
            <button type="button" title="下移" :disabled="isLast(mod)" @click="prompts.moveModule(mod.id, 1)">↓</button>
          </span>
        </div>
        <div class="tt-prompt-module-desc">{{ sourceDescription(mod) }}</div>
      </div>
    </div>

    <div class="tt-prompt-section-title">高级</div>
    <div class="tt-card">
      <div class="tt-card-title">外部插件内容搬运（可选）</div>
      <div class="tt-card-sub">
        勾选后，其他插件（如记忆摘要类）注入到酒馆的内容会被一并带给生成选项的 AI。默认全关。
      </div>
      <label class="tt-prompt-switch">
        <input type="checkbox" :checked="prompts.externalInjections.baibai" @change="prompts.setExternalInjections({ baibai: ($event.target as HTMLInputElement).checked })">
        <span>柏宝书剧情摘要</span>
        <span class="tt-prompt-module-desc">STBaiBaiBook（柏宝书）插件生成的剧情摘要；插件不在场时自动忽略。</span>
      </label>
      <label class="tt-prompt-switch">
        <input type="checkbox" :checked="prompts.externalInjections.allSlots" @change="prompts.setExternalInjections({ allSlots: ($event.target as HTMLInputElement).checked })">
        <span>其他插件注入的内容（全部搬入）</span>
        <span class="tt-prompt-module-desc">记忆/摘要类插件写到酒馆公共注入区的内容，开了就全部带给 AI，不用也不需要逐个挑。</span>
      </label>
      <div class="tt-prompt-slots">
        <div class="tt-card-sub">当前在场：{{ slots.length ? slots.map(s => s.key).join('、') : '无' }}</div>
        <button type="button" class="tt-prompt-refresh" @click="slots = listSlotPreviews()">重新扫描</button>
        <div v-if="!slots.length" class="tt-prompt-empty">没有插件写入槽位——点了「重新扫描」仍为空，说明记忆/摘要类插件未挂载或未写入。</div>
      </div>
      <div v-if="effective" class="tt-prompt-slots">
        <div class="tt-card-sub">对应管线模块（只管位置排序；启停由上面的开关承载，不设第二道门）</div>
        <div
          v-for="mod in externalModules"
          :key="mod.id"
          class="tt-prompt-module"
        >
          <div class="tt-prompt-module-head">
            <span class="tt-prompt-module-name">{{ mod.name }}</span>
            <span class="tt-prompt-module-ops">
              <button type="button" title="上移" :disabled="isFirst(mod)" @click="prompts.moveModule(mod.id, -1)">↑</button>
              <button type="button" title="下移" :disabled="isLast(mod)" @click="prompts.moveModule(mod.id, 1)">↓</button>
            </span>
          </div>
          <div class="tt-prompt-module-desc">{{ sourceDescription(mod) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { listSlotPreviews, moduleGroupOf, usePromptsStore, type DirectionPreset, type InjectModule, type InjectionSource, type PromptModule, type SlotPreview, type TextModule } from '@/prompts';

const prompts = usePromptsStore();

const editingId = ref('');
const slots = ref<SlotPreview[]>([]);

const effective = computed(() => prompts.effectiveConfig);
// G5 三分组共用同一条 order 管线：各组按 order 截取子序列呈现
// （filter 谓词收窄到 TextModule/InjectModule——组内模板用得到 kind 字段）
const textModules = computed(() => {
    const cfg = effective.value;
    if (!cfg) return [];
    return [...cfg.modules].sort((a, b) => a.order - b.order).filter((m): m is TextModule => m.kind === 'text');
});
const contextModules = computed(() => {
    const cfg = effective.value;
    if (!cfg) return [];
    return [...cfg.modules].sort((a, b) => a.order - b.order).filter((m): m is InjectModule => moduleGroupOf(m) === 'context_inject');
});
const externalModules = computed(() => {
    const cfg = effective.value;
    if (!cfg) return [];
    return [...cfg.modules].sort((a, b) => a.order - b.order).filter((m): m is InjectModule => moduleGroupOf(m) === 'external_inject');
});

/** 每项注入源的白话说明（G5：说明每项注入什么，替代裸 source 标识）。 */
const SOURCE_DESCRIPTIONS: Record<InjectionSource, string> = {
    persona: '用户人设：宿主「用户人设」面板里当前选中的那套自我描述。',
    char_description: '角色描述：角色卡「描述」栏的形象与背景设定。',
    char_personality: '角色性格：角色卡「性格」栏的性格概要。',
    char_scenario: '故事背景：角色卡「场景」栏自带的开场情境。',
    world_info_before: '世界书：当前激活的条目，注入在聊天历史之前。',
    world_info_after: '世界书：当前激活的条目，注入在聊天历史之后。',
    wi_depth_before: '世界书：按对话深度插入到历史中段的条目。',
    wi_depth_after: '世界书：按对话深度插入到历史后段的条目。',
    chat_history: '聊天历史：最近几轮对话（层数在「选项生成」页设置）；最新一条 AI 回复会标为当前场景。',
    story_direction: '剧情走向：本页「走向指引」里写的自由文本与已应用预设（随当前聊天保存）。',
    pool_entries: '条目池：池条目按固定必发（pinned）＋抽签候选两区注入，每次生成现场重抽（「条目池」页管理）。',
    external_slot: '其他插件注入到酒馆通用槽位的内容，按上方勾选搬入。',
    baibai: 'STBaiBaiBook（柏宝书）插件生成的剧情摘要。',
};

function sourceDescription(mod: PromptModule): string {
    return mod.kind === 'inject' ? SOURCE_DESCRIPTIONS[mod.source] : '';
}

function groupListOf(mod: PromptModule): PromptModule[] {
    const group = moduleGroupOf(mod);
    if (group === 'text') return textModules.value;
    if (group === 'context_inject') return contextModules.value;
    return externalModules.value;
}

function isFirst(mod: PromptModule): boolean {
    return groupListOf(mod)[0]?.id === mod.id;
}

function isLast(mod: PromptModule): boolean {
    const list = groupListOf(mod);
    return list[list.length - 1]?.id === mod.id;
}

function toggleEdit(mod: PromptModule): void {
    editingId.value = editingId.value === mod.id ? '' : mod.id;
}

/** 恢复默认模板（m03359）：单模板无备份面——改坏了的自救口。整体覆盖，先确认。 */
function resetTemplate(): void {
    if (!confirm('恢复默认模板？当前模板的所有修改会被出厂版本覆盖（不可撤销）。')) return;
    prompts.resetToDefault();
    editingId.value = '';
}

// ---- 剧情走向（m03359 整合轮从「选项生成」tab 挪入——走向是提示词素材，
//      编辑入口与模板同页；数据域与写入通道零改动） ----

// 自由文本防抖：每击键立即 setStoryDirection＝每击键一次 chat 域立即保存
// （saveMetadata 通道）——保存风暴。停输入 300ms 才落盘；预设应用/取消
// 是单次点击、保持立即保存，不进防抖。
const DIRECTION_TEXT_DEBOUNCE_MS = 300;
let directionTextTimer: ReturnType<typeof setTimeout> | undefined;

function onDirectionTextInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    if (directionTextTimer !== undefined) clearTimeout(directionTextTimer);
    directionTextTimer = setTimeout(() => {
        directionTextTimer = undefined;
        prompts.setStoryDirection({ freeText: value });
    }, DIRECTION_TEXT_DEBOUNCE_MS);
}

function presetLabel(preset: DirectionPreset): string {
    // 预设无独立名字段（G4 最小形态：预设＝文本本体）——标签条显示
    // 截断文本，完整内容在 title 悬浮
    const text = preset.text.trim();
    return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

/** 点击预设＝应用（写入 presetText 快照）；再点同一预设＝取消应用。 */
function togglePreset(preset: DirectionPreset): void {
    if (prompts.storyDirection.presetText === preset.text) {
        prompts.setStoryDirection({ presetText: '' });
    } else {
        prompts.setStoryDirection({ presetText: preset.text });
    }
}

function saveCurrentTextAsPreset(): void {
    const text = prompts.storyDirection.freeText.trim();
    if (!text) return;
    prompts.addDirectionPreset(text);
}

function removePreset(preset: DirectionPreset): void {
    if (!confirm(`删除预设「${presetLabel(preset)}」？（已应用该预设的聊天不受影响）`)) return;
    prompts.deleteDirectionPreset(preset.id);
}

// 防抖挂起期间离开设置页（含切聊天后卸载）：不落盘半截文本——
// 落盘目标 chat 域可能已随卸载切换，迟到的写会进错聊天
onBeforeUnmount(() => {
    if (directionTextTimer !== undefined) clearTimeout(directionTextTimer);
});

// 挂载时预扫一次槽位；运行期插件动态写入由「重新扫描」按钮重扫
// （宿主槽位表非响应式，无法自动追踪）
onMounted(() => {
    slots.value = listSlotPreviews();
});
</script>

<style>
.tt-prompt-intro {
    font-size: 0.85em;
    opacity: 0.85;
    padding: 0 2px 6px;
}

.tt-prompt-section-title {
    font-size: 0.92em;
    font-weight: bold;
    margin: 10px 2px 4px;
    padding-bottom: 2px;
    border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #666) 55%, transparent);
}

/* 恢复默认按钮（m03359：单模板自救口） */
.tt-prompt-reset-btn {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 10px;
    font-size: 0.78em;
    cursor: pointer;
}

.tt-prompt-reset-btn:hover {
    color: var(--SmartThemeQuoteColor, #c58a36);
}

/* 剧情走向卡（m03359 从「选项生成」tab 挪入；类名换 tt-prompt- 前缀自持，
   不依赖 ChoiceSettingsTab 的 tt-choice- 样式块） */
.tt-prompt-field--block {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 6px;
    font-size: 0.85em;
}

.tt-prompt-field--block textarea {
    background: color-mix(in srgb, var(--SmartThemeBorderColor, #666) 18%, transparent);
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 4px 6px;
    font-family: inherit;
    font-size: 0.9em;
    resize: vertical;
}

.tt-prompt-presets-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.85em;
    opacity: 0.8;
    margin-bottom: 4px;
}

.tt-prompt-presets-head button {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 10px;
    font-size: 0.85em;
    cursor: pointer;
}

.tt-prompt-presets-head button:disabled {
    opacity: 0.4;
    cursor: default;
}

.tt-prompt-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.tt-prompt-tag {
    background: color-mix(in srgb, var(--SmartThemeBorderColor, #666) 25%, transparent);
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 0.8em;
    cursor: pointer;
}

.tt-prompt-tag--active {
    border-color: var(--SmartThemeQuoteColor, #c58a36);
}

.tt-prompt-tag-del {
    /* 删除叉与标签文本同为按钮内容——独立悬浮态只归删除叉 */
    display: inline-block;
    margin-left: 6px;
    padding: 0 2px;
    opacity: 0.55;
}

.tt-prompt-tag-del:hover {
    opacity: 1;
    color: var(--SmartThemeQuoteColor, #c58a36);
}

.tt-prompt-note {
    font-size: 0.75em;
    opacity: 0.6;
    padding: 4px 0 0;
}

.tt-prompt-module {
    border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #666) 55%, transparent);
    border-radius: 6px;
    padding: 4px 8px;
    margin-bottom: 4px;
}

.tt-prompt-module--disabled {
    opacity: 0.55;
}

.tt-prompt-module-head {
    display: flex;
    align-items: center;
    gap: 8px;
}

.tt-prompt-module-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
    cursor: pointer;
    min-width: 0;
}

.tt-prompt-module-name {
    font-size: 0.85em;
}

.tt-prompt-module-ops {
    margin-left: auto;
    display: flex;
    gap: 4px;
    flex-shrink: 0;
}

.tt-prompt-module-ops button {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 4px;
    padding: 1px 8px;
    font-size: 0.78em;
    cursor: pointer;
}

.tt-prompt-module-ops button:disabled {
    opacity: 0.35;
    cursor: default;
}

.tt-prompt-module-desc {
    font-size: 0.72em;
    opacity: 0.6;
    margin: 2px 0 0 22px;
}

.tt-prompt-module-editor {
    width: 100%;
    box-sizing: border-box;
    margin-top: 4px;
    background: var(--SmartThemeChatTintColor, rgba(128, 128, 128, 0.1));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 4px 6px;
    font-family: monospace;
    font-size: 0.8em;
    resize: vertical;
}

.tt-prompt-switch {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 0.85em;
    cursor: pointer;
}

.tt-prompt-slots {
    margin-top: 6px;
    border-top: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor, #666) 40%, transparent);
    padding-top: 6px;
}

.tt-prompt-refresh {
    background: transparent;
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, #666);
    border-radius: 5px;
    padding: 2px 10px;
    font-size: 0.78em;
    cursor: pointer;
    margin-bottom: 4px;
}

.tt-prompt-empty {
    font-size: 0.8em;
    opacity: 0.6;
    padding: 4px 0;
}
</style>
