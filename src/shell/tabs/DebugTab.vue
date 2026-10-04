<template>
  <div class="tt-debug-tab">
    <div class="tt-card">
      <div class="tt-card-title">storage 写读 roundtrip</div>
      <div class="tt-card-sub">向全局域与聊天域各写一个随机 token 并读回比对（与用户数据同链路）</div>
      <div class="tt-actions">
        <button type="button" @click="runRoundtrip">运行 roundtrip</button>
      </div>
      <ul v-if="roundtrip.length" class="tt-probe-list">
        <li v-for="r in roundtrip" :key="r.scope">
          <span :class="r.ok ? 'tt-roundtrip-ok' : 'tt-roundtrip-fail'">{{ r.ok ? 'PASS' : 'FAIL' }}</span>
          {{ r.scope }} 域：写入 {{ r.written }} / 读回 {{ r.readBack }} @ {{ r.at }}
        </li>
      </ul>
    </div>

    <div class="tt-card">
      <div class="tt-card-title">host 适配层 API 探测清单</div>
      <div class="tt-card-sub">适配层依赖的宿主能力逐项在场/缺席检查（批A 判据载体）</div>
      <div class="tt-actions">
        <button type="button" @click="runProbe">运行探测</button>
      </div>
      <ul v-if="probeResults.length" class="tt-probe-list">
        <li v-for="p in probeResults" :key="p.name">
          <span class="tt-probe-tag" :class="p.present ? 'tt-probe-tag--present' : 'tt-probe-tag--absent'">
            {{ p.present ? '在场' : '缺席' }}
          </span>
          {{ p.name }} — {{ p.detail }}
        </li>
      </ul>
    </div>

    <div class="tt-card">
      <div class="tt-card-title">storage 快照</div>
      <div class="tt-actions">
        <button type="button" @click="dump = dumpStorage()">刷新快照</button>
      </div>
      <pre v-if="dump" class="tt-dump">{{ dump }}</pre>
    </div>

    <div class="tt-card">
      <div class="tt-card-title">nav 模块日志（__TT_NAV__.dump()）</div>
      <div class="tt-actions">
        <button type="button" @click="navDump = readNavDump()">刷新 nav dump</button>
      </div>
      <pre v-if="navDump" class="tt-dump">{{ navDump }}</pre>
    </div>

    <div class="tt-card">
      <div class="tt-card-title">消息组装 dump</div>
      <div class="tt-card-sub">
        用当前宿主数据跑一次完整组装（与实际发送同一管线）——各模块注入与否逐项可见。控制台口：__TTK_PROMPTS__.dump()
      </div>
      <div class="tt-actions">
        <button type="button" :disabled="dumpRunning" @click="runDump">{{ dumpRunning ? '组装中…' : '运行组装' }}</button>
        <button v-if="promptDumpText" type="button" @click="copyDump">复制</button>
      </div>
      <pre v-if="promptDumpText" class="tt-dump">{{ promptDumpText }}</pre>
      <div v-else-if="promptDumpError" class="tt-dump-error">{{ promptDumpError }}</div>
    </div>

    <div class="tt-card">
      <div class="tt-card-title">选项解析回退调试（批B 判据）</div>
      <div class="tt-card-sub">
        「回退解析」是模型输出不合 JSON 约定时的宽松解析安全网（主编辑面不出现，只在选项条上以小标注提示）。
        「强制畸形输出」开启后，点选项条「生成选项」会跳过 API、直接用固定畸形样本走解析路径——
        回退解析结果应显示 4 条带标题选项，且选项条标注「回退解析」。
      </div>
      <div class="tt-switch-row">
        <input
          id="tt-debug-force-raw"
          type="checkbox"
          :checked="forceRaw"
          @change="onToggleForceRaw"
        >
        <label for="tt-debug-force-raw">生成时强制喂畸形输出（走回退解析路径）</label>
      </div>
      <div class="tt-actions">
        <button type="button" @click="runMalformedParse">直接解析固定畸形样本</button>
      </div>
      <pre v-if="malformedResult" class="tt-dump">{{ malformedResult }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { formatProbeResults, probeHost, type ProbeResult } from '@/host';
import { dumpStorage, runStorageRoundtrip, type RoundtripReport } from '@/storage';
import { DEBUG_MALFORMED_RAW, parseOptions } from '@/modules/choice/parse';
import { choiceStorage } from '@/modules/choice/api';
import { assembleCurrent } from '@/modules/choice/generator';
import { useChoiceStore } from '@/modules/choice/store';

const roundtrip = ref<RoundtripReport[]>([]);
const probeResults = ref<ProbeResult[]>([]);
const dump = ref('');
const navDump = ref('');
const forceRaw = ref(choiceStorage.readDomain().gen.debugForceRaw);
const malformedResult = ref('');
// 消息组装 dump（G5 从提示词主编辑面迁入调试 tab 的黑话面）
const promptDumpText = ref('');
const promptDumpError = ref('');
const dumpRunning = ref(false);
const choiceStore = useChoiceStore();

function runRoundtrip(): void {
    roundtrip.value = runStorageRoundtrip();
}

function runProbe(): void {
    probeResults.value = probeHost();
    // 同时落 console：机判/排障可从控制台直接读全量
    console.info(`[tt-toolkit][debug] host 探测清单：\n${formatProbeResults(probeResults.value)}`);
}

function readNavDump(): string {
    const nav = (globalThis as { __TT_NAV__?: { dump?: () => string } }).__TT_NAV__;
    if (typeof nav?.dump !== 'function') return '（nav 模块尚未初始化，__TT_NAV__ 不在场）';
    return nav.dump();
}

function onToggleForceRaw(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    choiceStorage.updateGenParams({ debugForceRaw: checked });
    forceRaw.value = checked;
}

async function runDump(): Promise<void> {
    dumpRunning.value = true;
    promptDumpError.value = '';
    try {
        const { dumpText: text } = await assembleCurrent();
        promptDumpText.value = text;
        choiceStore.lastDump = text;
    } catch (e) {
        promptDumpError.value = `组装失败：${e instanceof Error ? e.message : String(e)}`;
    } finally {
        dumpRunning.value = false;
    }
}

async function copyDump(): Promise<void> {
    try {
        await navigator.clipboard.writeText(promptDumpText.value);
    } catch {
        // 剪贴板权限拒绝：无提示降级（内容已在 <pre> 中可手选）
    }
}

function runMalformedParse(): void {
    const report = parseOptions(DEBUG_MALFORMED_RAW, 4);
    const lines = [
        `解析路径：${report.path}（期望 bracket_fallback）`,
        `解析条数：${report.options.length}（期望 4）`,
        '',
        ...report.options.map((o, i) => `[${i + 1}] ${o.title}｜${o.content}`),
    ];
    malformedResult.value = lines.join('\n');
    console.info(`[tt-toolkit][debug] 畸形样本解析：${report.path} / ${report.options.length} 条`);
}
</script>

<style>
.tt-dump-error {
    color: var(--SmartThemeQuoteColor, #c58a36);
    font-size: 0.8em;
}
</style>
