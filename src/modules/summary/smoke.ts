/**
 * node 冒烟的 summary 机判部分：触发算术＋守卫链＋状态机＋槽组合
 * ＋完整链端到端＋事件接线（scripts/smoke.mjs 收口断言，与 choice/persona
 * smoke 同构：check() 打 [summary-smoke] PASS/FAIL 行）。
 *
 * 全部走 stub 宿主数据（chat 数组／端点表／dispatching fetch 桩），
 * 与浏览器真实数据共用同一条 generator/state/slot 代码路径。每段
 * 自清理：stub 单例跨段共享（boot2 重跑同段），不留 fixture 残留。
 */
import { event_types, extension_settings, type ChatMessage } from '@/host';
import { serializeOutbound } from '@/modules/apis/client';
import { createEndpoint, readApiDomain, writeApiDomain } from '@/modules/apis/storage';
import { mutateTaskProfiles, readTaskProfiles, writeTaskProfiles, type TaskProfilesDomain } from '@/modules/apis/task-profiles';
import { TASK_IDS } from '@/tasks';
import { useRunlogStore } from '@/modules/runlog/store';
import { handleSummaryMessageReceived, installSummaryAuto } from './auto';
import { useSummaryStore } from './store';
import { parseJudgeResponse, runSummaryJudge } from './judge';
import { MAX_FLOORS_PER_RUN, planAutoPhase, planManualSmallSummary, roundsToTrigger, shouldRunBigSummary } from './arithmetic';
import { buildBigSourceText, buildSmallSourceText, cancelSummaryGeneration, isSummaryRunning, restoreAllSummaries, runBigSummary, runSmallSummary } from './generator';
import { DEFAULT_SUMMARY_SETTINGS, normalizeSummaryChatState, normalizeSummarySettings, readSummaryChatState, writeSummaryChatState, writeSummarySettings } from './settings';
import { clearSummarySlot, SLOT_KEY } from './slot';
import { composeSlotValue } from './slot-compose';
import { currentFoldEpoch, hiddenFloorCount, hideFloors, isRawFloor, isSummaryHiddenFloor, rawFloorIndices, restoreAllFloors, selfHealSummaryState } from './state';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
    console.info(`[summary-smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

interface SmokeStubs {
    getContext(): { chat: Array<Record<string, unknown>>; extensionPrompts: Record<string, { value: string; position: number; depth: number; scan: boolean; role: number }>; [key: string]: unknown };
    /** 聊天域写通道的物理挂载点（chat 域键的缺席态还原用）。 */
    chat_metadata: Record<string, unknown>;
    /** 宿主事件源（emit 是宿主特权——测试侧直发 CHAT_CHANGED 触发真实接线）。 */
    eventSource: { emit(type: string, ...args: unknown[]): Promise<void> };
    saveChatCalls: number;
    generateCalls: Array<{ url: string; body: Record<string, unknown> }>;
}

function smokeStubs(): SmokeStubs {
    return (globalThis as unknown as { __TT_SMOKE_STUBS__: SmokeStubs }).__TT_SMOKE_STUBS__;
}

/** 五行任务档案统一种子（全部指向同一服务商＋模型）。 */
function seedTaskProfiles(providerId: string, model: string): void {
    const profiles = {} as TaskProfilesDomain;
    for (const id of TASK_IDS) profiles[id] = { providerId, model };
    writeTaskProfiles(profiles);
}

interface FakeMessage extends Record<string, unknown> {
    mes?: string;
    is_user?: boolean;
    is_system?: boolean;
    name?: string;
    extra?: Record<string, unknown>;
}

const msg = (mes: string, opts: Partial<FakeMessage> = {}): FakeMessage => ({ mes, is_user: false, ...opts });

/** 种一段干净聊天：偶数索引＝user 楼、奇数索引＝AI 楼（floor 0 开场白归 user 侧）。 */
function seedChat(count: number): void {
    const chat: FakeMessage[] = [];
    for (let i = 0; i < count; i++) {
        chat.push(i % 2 === 0 ? msg(`用户第${i}楼：走到旧货铺门口。`, { is_user: true }) : msg(`AI第${i}楼：推门而入，见了老板。`, { name: '林霜' }));
    }
    smokeStubs().getContext().chat = chat;
}

function flags(): boolean[] {
    return smokeStubs().getContext().chat.map(m => isSummaryHiddenFloor(m as ChatMessage));
}

function slotState(): { value: string; position: number; depth: number; scan: boolean; role: number } | undefined {
    return smokeStubs().getContext().extensionPrompts[SLOT_KEY];
}

function emptyStateJson(): string {
    return JSON.stringify({ smallSummaries: [], bigSummary: '' });
}

async function waitFor(pred: () => boolean, tries = 100): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
        if (pred()) return true;
        await new Promise(r => setTimeout(r, 20));
    }
    return pred();
}

/** 判断请求桩响应：SSE 流式帧形态与 client.ts 流式消费契约对齐。 */
function judgeSseResponse(content: string): Response {
    const encoder = new TextEncoder();
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => {
                const frames = [encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`), encoder.encode('data: [DONE]\n\n')];
                return {
                    read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true },
                    cancel: async () => undefined,
                };
            },
        },
    } as unknown as Response;
}

// ---------------------------------------------------------------------------
// 5.5) 判断器：解析三级＋破限豁免＋端到端（stub 回包）＋窗口错误楼过滤
// ---------------------------------------------------------------------------

async function runJudgeChecks(): Promise<void> {
    const stubs = smokeStubs();
    const savedEndpoints = readApiDomain();
    const savedProfilesJson = JSON.stringify(readTaskProfiles());
    const baseFetch = globalThis.fetch;
    let savedName1: unknown;
    let savedName2: unknown;
    try {
        // speaker 名直配 stubContext（上一段 finally 已还原成缺席——【王玉】断言依赖它）
        savedName1 = stubs.getContext().name1;
        savedName2 = stubs.getContext().name2;
        stubs.getContext().name1 = '王玉';
        stubs.getContext().name2 = '林霜';
        check('judge 解析①：整体 JSON 采信（should_summarize 布尔＋reason 透传）',
            (() => { const r = parseJudgeResponse('{"should_summarize": true, "reason": "场景收尾。"}'); return r.shouldSummarize === true && r.reason === '场景收尾。'; })()
            && (() => { const r = parseJudgeResponse('{"should_summarize": false}'); return r.shouldSummarize === false && r.reason === ''; })());
        check('judge 解析②：宽松文本退正则首个命中',
            parseJudgeResponse('模型输出：{"should_summarize" : false}——以上。').shouldSummarize === false
            && parseJudgeResponse('前言 {"x":1} {"should_summarize": true} 后语').shouldSummarize === true);
        check('judge 解析③：全坏 → null（非 JSON／JSON 缺布尔字段）',
            parseJudgeResponse('我觉得还不到时候。').shouldSummarize === null
            && parseJudgeResponse('{"reason": "没给字段"}').shouldSummarize === null);
        check('judge：serializeOutbound 无破限前缀（summary_judge 豁免，日志与实发同源）',
            serializeOutbound([{ role: 'user', content: '正文' }], 'summary_judge') === '[user]\n正文');

        const endpoint = createEndpoint('judge冒烟服务商');
        endpoint.url = 'https://judge-smoke.example.com/v1';
        endpoint.key = 'sk-judge';
        endpoint.models = ['judge-model'];
        writeApiDomain([endpoint]);
        mutateTaskProfiles(profiles => {
            profiles.summary_judge = { providerId: endpoint.id, model: 'judge-model' };
        });
        // 端到端：好 JSON → 判 true；窗口内错误正文楼被过滤
        seedChat(8);
        const errChat = stubs.getContext().chat as Array<Record<string, unknown>>;
        errChat[2] = { mes: '[API 错误]\n连接目标服务失败：当前网络、VPN、代理或接口地址可能暂时不可用。', is_user: true };
        stubs.generateCalls.length = 0;
        globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            stubs.generateCalls.push({ url: String(_url), body });
            return judgeSseResponse(JSON.stringify({ should_summarize: true, reason: '一场争执刚收尾。' }));
        }) as typeof fetch;
        const verdict = await runSummaryJudge();
        const call = stubs.generateCalls[0];
        const judgeMessages = (call?.body.messages ?? []) as Array<{ role: string; content: string }>;
        const judgeUserText = judgeMessages.find(m => m.role === 'user')?.content ?? '';
        check('judge e2e：好 JSON → 判 true＋reason 透传；请求温度 0.2、json_object 契约、流式',
            verdict.kind === 'judged' && verdict.shouldSummarize === true && verdict.reason === '一场争执刚收尾。'
            && call?.body.temperature === 0.2 && (call?.body.response_format as { type?: string } | undefined)?.type === 'json_object'
            && call?.body.stream === true && call?.body.model === 'judge-model',
            `kind=${verdict.kind}`);
        check('judge e2e：user 消息带距上次总结楼数与窗口楼层文本（speaker 标注形态）、system 即判断模板',
            judgeUserText.startsWith('8 messages have passed since the last summary.')
            && judgeUserText.includes('【王玉】') && !judgeUserText.includes('连接目标服务失败')
            && judgeMessages[0]?.role === 'system' && judgeMessages[0]?.content.startsWith('You are the summary timing judge')
            && judgeMessages.length === 2,
            `messages=${judgeMessages.length}`);
        // 空白窗口（全部楼层都是错误正文）与传输失败：都按判 null 静默收口
        const errOnly = stubs.getContext().chat as Array<Record<string, unknown>>;
        for (let i = 0; i < errOnly.length; i++) errOnly[i] = { mes: `[API 错误]\n失败${i}`, is_user: i % 2 === 0 };
        const blankWindow = await runSummaryJudge();
        globalThis.fetch = (async () => { throw new Error('网络断开'); }) as typeof fetch;
        const failed = await runSummaryJudge();
        check('judge 失败面：空白窗口不白发请求、传输失败/垃圾回包 → 判 null（不重试不抛）',
            blankWindow.kind === 'judged' && blankWindow.shouldSummarize === null
            && failed.kind === 'judged' && failed.shouldSummarize === null,
            `blank=${blankWindow.kind}/${blankWindow.kind === 'judged' ? String(blankWindow.shouldSummarize) : ''} failed=${failed.kind === 'judged' ? String(failed.shouldSummarize) : failed.kind}`);
    } finally {
        globalThis.fetch = baseFetch;
        writeApiDomain(savedEndpoints);
        writeTaskProfiles(JSON.parse(savedProfilesJson) as TaskProfilesDomain);
        stubs.getContext().name1 = savedName1;
        stubs.getContext().name2 = savedName2;
        stubs.getContext().chat = [];
        stubs.generateCalls.length = 0;
    }
}

// ---------------------------------------------------------------------------
// 1) 触发算术（纯函数：多组 interval/keep＋取偶＋上限＋级联条件＋同源换算）
// ---------------------------------------------------------------------------

function runArithmeticChecks(): void {
    // fixed 模式回归（行为保真红线）：现行语义「aged ≥ interval×2 → force，否则 wait」原样
    const fixed = { intervalRounds: 3, keepRounds: 3, triggerMode: 'fixed' as const, maxIntervalRounds: 8, judgeEveryRounds: 1 };
    check('算术：fixed 相位映射回归（达标 force／未达标 wait，与改版前算术逐例同判）',
        planAutoPhase(14, fixed, null).phase === 'force'
        && planAutoPhase(12, fixed, null).phase === 'force'
        && planAutoPhase(10, fixed, null).phase === 'wait'
        && planAutoPhase(13, { ...fixed, intervalRounds: 1 }, null).phase === 'force'
        && planAutoPhase(4, fixed, null).phase === 'wait',
        `样本=${JSON.stringify([14, 12, 10, 13, 4].map(raw => planAutoPhase(raw, fixed, null)))}`);
    // adaptive 三相位：最少间隔内 wait → 区间内 judge（askNow 按 lastAskedAged 节流）→ 强制线 force
    const adaptive = { intervalRounds: 3, keepRounds: 3, triggerMode: 'adaptive' as const, maxIntervalRounds: 8, judgeEveryRounds: 1 };
    const phaseName = (raw: number, lastAsked: number | null) => planAutoPhase(raw, adaptive, lastAsked).phase;
    const askNowOf = (raw: number, lastAsked: number | null): boolean => {
        const p = planAutoPhase(raw, adaptive, lastAsked);
        return p.phase === 'judge' && p.askNow;
    };
    check('算术：adaptive 三相位（不足最少间隔 wait／区间 judge／达强制线 force）',
        phaseName(10, null) === 'wait' && phaseName(4, null) === 'wait'
        && phaseName(12, null) === 'judge' && askNowOf(12, null) === true
        && phaseName(22, null) === 'force' && phaseName(200, null) === 'force');
    check('算术：askNow 节流（从未询问即问；距上次询问满 judgeEvery 轮才再问，半轮不算满）',
        askNowOf(12, null) === true
        && askNowOf(12, 6) === false
        && askNowOf(13, 6) === false
        && askNowOf(14, 6) === true
        && (() => { const p = planAutoPhase(12, { ...adaptive, judgeEveryRounds: 2 }, 6); return p.phase === 'judge' && !p.askNow; })()
        && (() => { const p = planAutoPhase(16, { ...adaptive, judgeEveryRounds: 2 }, 6); return p.phase === 'judge' && p.askNow; })());
    check('算术：手动只要求 aged≥2（无间隔门槛、上限同封顶）',
        planManualSmallSummary(8, 3).batchSize === 2 && planManualSmallSummary(6, 3).batchSize === 0 && planManualSmallSummary(200, 1).batchSize === MAX_FLOORS_PER_RUN);
    check('算术：大总结级联条件（未折叠小总结攒满 bigEvery 即触发）',
        shouldRunBigSummary(2, 3) === false && shouldRunBigSummary(3, 3) === true && shouldRunBigSummary(4, 2) === true);
    check('算术：roundsToTrigger 与自动守卫同源（缺口换算、达标为 0）',
        roundsToTrigger(10, 3, 3) === 1 && roundsToTrigger(14, 3, 3) === 0 && roundsToTrigger(6, 3, 3) === 3,
        `样本=${[roundsToTrigger(10, 3, 3), roundsToTrigger(14, 3, 3), roundsToTrigger(6, 3, 3)].join('/')}`);
}

// ---------------------------------------------------------------------------
// 2) 槽组合四种形态（逐字字面断言）
// ---------------------------------------------------------------------------

function runSlotComposeChecks(): void {
    const header = '以下是本对话更早剧情的压缩摘要（对应楼层已折叠，不再单独发送）。摘要内容均为已经发生的事实，与后续对话历史具有同等效力，不得与之矛盾，也不要重复摘要中已记录的情节。';
    check('槽组合：两者皆空＝空串（清槽）', composeSlotValue({ bigSummary: '', smalls: [] }) === '');
    const bigOnly = composeSlotValue({ bigSummary: '旧文摘要。', smalls: [] });
    check('槽组合：只大总结（省略小总结节、模板逐字）',
        bigOnly === `${header}\n\n<前情摘要>\n【大总结】\n旧文摘要。\n</前情摘要>`, `got=${JSON.stringify(bigOnly)}`);
    const smallsOnly = composeSlotValue({
        bigSummary: '',
        smalls: [
            { text: '第一条摘要。', fromFloor: 0, toFloor: 5 },
            { text: '第二条摘要。', fromFloor: 6, toFloor: 11 },
        ],
    });
    check('槽组合：只小总结（省略大总结节、批次序号＋1 基楼层区间、多条空行分隔）',
        smallsOnly === `${header}\n\n<前情摘要>\n【小总结·近期】\n【小总结·第1批｜约第1-6楼】\n第一条摘要。\n\n【小总结·第2批｜约第7-12楼】\n第二条摘要。\n</前情摘要>`,
        `got=${JSON.stringify(smallsOnly)}`);
    const both = composeSlotValue({ bigSummary: '旧文。', smalls: [{ text: '近期摘要。', fromFloor: 0, toFloor: 3 }] });
    check('槽组合：双节（大总结段在前、小总结段在后）',
        both === `${header}\n\n<前情摘要>\n【大总结】\n旧文。\n\n【小总结·近期】\n【小总结·第1批｜约第1-4楼】\n近期摘要。\n</前情摘要>`,
        `got=${JSON.stringify(both)}`);
}

// ---------------------------------------------------------------------------
// 3) 状态机：hide/restore/selfHeal 的 flag×is_system 联动（stub chat 驱动）
// ---------------------------------------------------------------------------

function runStateChecks(): void {
    const stubs = smokeStubs();
    const epochBase = currentFoldEpoch();
    seedChat(6);
    check('状态：raw 判定含开场白 floor 0（全部新楼层皆 raw）',
        rawFloorIndices().length === 6 && rawFloorIndices()[0] === 0);
    const saveBefore = stubs.saveChatCalls;
    check('状态：hideFloors 写 is_system＋flag 并批量落盘一次',
        hideFloors([0, 2]) === 2
        && stubs.getContext().chat[0]?.is_system === true && flags().filter(Boolean).length === 2
        && hiddenFloorCount() === 2 && stubs.saveChatCalls === saveBefore + 1,
        `saveDelta=${stubs.saveChatCalls - saveBefore}`);
    check('状态：hidden 楼层退出 raw 集', JSON.stringify(rawFloorIndices()) === JSON.stringify([1, 3, 4, 5]));
    // belt-and-braces：自愈间隙里被手动翻回 is_system 的 flag 楼层不当 raw
    const unhidden = stubs.getContext().chat[0];
    if (unhidden) unhidden.is_system = false;
    check('状态：flag 楼层被翻回 is_system 后仍不算 raw（防重复总结）',
        !isRawFloor(stubs.getContext().chat[0] as ChatMessage));
    const healSaveBefore = stubs.saveChatCalls;
    const heal = selfHealSummaryState();
    check('状态：selfHeal 重新隐藏 flag 且 is_system 被翻回的楼层（落盘一次）',
        heal.rehidden === 1 && stubs.getContext().chat[0]?.is_system === true && stubs.saveChatCalls === healSaveBefore + 1,
        `rehidden=${heal.rehidden}`);
    check('状态：selfHeal 幂等复跑零变化', selfHealSummaryState().rehidden === 0);
    check('状态：restoreAllFloors 翻回 is_system＋删 flag',
        restoreAllFloors() === 2 && hiddenFloorCount() === 0 && flags().every(f => !f)
        && stubs.getContext().chat[0]?.is_system === false);
    // 一键还原（楼层＋聊天态＋槽）
    hideFloors([1, 3]);
    writeSummaryChatState({ smallSummaries: [{ text: 's', fromFloor: 0, toFloor: 1 }], bigSummary: 'b' });
    clearSummarySlot();
    const restored = restoreAllSummaries();
    check('状态：restoreAllSummaries 一键还原（楼层翻回＋聊天态清空＋槽清位）',
        restored.kind === 'restored' && restored.floors === 2
        && hiddenFloorCount() === 0
        && JSON.stringify(readSummaryChatState()) === emptyStateJson()
        && slotState()?.value === '' && slotState()?.position === -1,
        `kind=${restored.kind}`);
    // 本段折叠/还原共四落地（hide×2＋restore×2），selfHeal 两次零推进——
    // 纪元是判断询问锚点的作废信号，漏推进＝跨周期锚点失准
    check('状态：折叠/还原各推进 foldEpoch、selfHeal 不推进（aged 锚点作废信号）',
        currentFoldEpoch() === epochBase + 4, `epoch=${currentFoldEpoch()} base=${epochBase}`);
}

// ---------------------------------------------------------------------------
// 4) normalize 值域钳制
// ---------------------------------------------------------------------------

function runNormalizeChecks(): void {
    const s = normalizeSummarySettings({ intervalRounds: 0, keepRounds: 25, bigEvery: 1, autoEnabled: 'yes' });
    check('normalize：下界钳制＋坏类型回默认（interval 1-20/keep 1-20/big 2-10、开关布尔化）',
        s.intervalRounds === 1 && s.keepRounds === 20 && s.bigEvery === 2 && s.autoEnabled === false, JSON.stringify(s));
    const s2 = normalizeSummarySettings({ intervalRounds: 21, keepRounds: 7, bigEvery: 99, autoEnabled: true });
    check('normalize：上界钳制＋合法值保真',
        s2.intervalRounds === 20 && s2.keepRounds === 7 && s2.bigEvery === 10 && s2.autoEnabled === true);
    check('normalize：triggerMode 枚举外回 fixed、合法 adaptive 保真',
        normalizeSummarySettings({ triggerMode: 'junk' }).triggerMode === 'fixed'
        && normalizeSummarySettings({ triggerMode: 'adaptive' }).triggerMode === 'adaptive'
        && normalizeSummarySettings(undefined).triggerMode === 'fixed');
    const s3 = normalizeSummarySettings({ intervalRounds: 10, maxIntervalRounds: 8, judgeEveryRounds: 0 });
    check('normalize：强制线下界随 interval 抬动（interval 10 时 8 抬到 12）、judgeEvery 下界钳 1',
        s3.maxIntervalRounds === 12 && s3.judgeEveryRounds === 1, JSON.stringify(s3));
    const s4 = normalizeSummarySettings({ maxIntervalRounds: 99, judgeEveryRounds: 11 });
    check('normalize：强制线上界 40、judgeEvery 上界 10、缺席默认 8/1（强制线 8≥3+2 不抬）',
        s4.maxIntervalRounds === 40 && s4.judgeEveryRounds === 10
        && normalizeSummarySettings(undefined).maxIntervalRounds === 8
        && normalizeSummarySettings(undefined).judgeEveryRounds === 1, JSON.stringify(s4));
    check('normalize：缺席键回默认 3/3/3（开关默认关）',
        JSON.stringify(normalizeSummarySettings(undefined)) === JSON.stringify(DEFAULT_SUMMARY_SETTINGS));
    const junk = normalizeSummaryChatState({ smallSummaries: [{ text: '好', fromFloor: 0, toFloor: 1 }, '垃圾', null], bigSummary: 5 });
    check('normalize：聊天态坏条目剔除＋坏类型回默认',
        junk.smallSummaries.length === 1 && junk.smallSummaries[0]?.text === '好' && junk.bigSummary === '');
}

// ---------------------------------------------------------------------------
// 5) 守卫链＋完整链端到端＋级联（dispatching fetch 桩由 smoke.mjs 提供）
// ---------------------------------------------------------------------------

const SUMMARY_TEXT = '王玉与林霜在旧货铺重逢，谈起初见；两人约定三日后同去钟楼，关系就此缓和。';

async function runGenerationChecks(): Promise<void> {
    const stubs = smokeStubs();
    const savedEndpoints = readApiDomain();
    const savedProfilesJson = JSON.stringify(readTaskProfiles());
    const ttDomain = extension_settings.ttToolkit as Record<string, unknown>;
    const savedSettings = ttDomain.summary;
    const endpoint = createEndpoint('summary冒烟服务商');
    endpoint.url = 'https://summary-smoke.example.com/v1';
    endpoint.key = 'sk-summary';
    endpoint.models = ['summary-model'];
    writeApiDomain([endpoint]);
    seedTaskProfiles(endpoint.id, 'summary-model');
    // speaker 名直配 stubContext（宿主同源字段 name1/name2；finally 还原防跨段污染）
    const savedName1 = stubs.getContext().name1;
    const savedName2 = stubs.getContext().name2;
    stubs.getContext().name1 = '王玉';
    stubs.getContext().name2 = '林霜';
    const baseFetch = globalThis.fetch;
    try {
        writeSummaryChatState({ smallSummaries: [], bigSummary: '' });
        // ---- 守卫链：busy（互斥）→ 生成期取消零改动 → autoEnabled → 算术 → 端点 → 可总结楼层 ----
        seedChat(10);
        let releaseFetch: ((value: Response) => void) | null = null;
        globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
            return new Promise(resolve => {
                releaseFetch = resolve;
                init?.signal?.addEventListener('abort', () => resolve(new Response(null, { status: 599 })));
            });
        }) as typeof fetch;
        const pending = runSmallSummary({ auto: false });
        await waitFor(() => releaseFetch !== null);
        const busyOutcome = await runSmallSummary({ auto: false });
        check('守卫：生成中二次触发被互斥拦下（busy，不重入）', busyOutcome.kind === 'busy' && isSummaryRunning());
        cancelSummaryGeneration();
        const cancelledOutcome = await pending;
        check('守卫：生成完成之前取消＝outcome cancelled 且零改动（失败/取消不动任何楼层与状态）',
            cancelledOutcome.kind === 'cancelled' && !isSummaryRunning()
            && hiddenFloorCount() === 0 && flags().every(f => !f)
            && JSON.stringify(readSummaryChatState()) === emptyStateJson(),
            `kind=${cancelledOutcome.kind}`);
        // autoEnabled=false：auto 触发跳过（manual 不受开关约束）
        ttDomain.summary = { autoEnabled: false, intervalRounds: 3, keepRounds: 3, bigEvery: 3 };
        const autoOff = await runSmallSummary({ auto: true });
        check('守卫：autoEnabled=false 时自动触发跳过',
            autoOff.kind === 'skipped' && autoOff.reason.includes('自动总结未开启'), `kind=${autoOff.kind}`);
        // 算术不达标：aged 4 < 2×3（开关先开回——上一守卫只验 autoEnabled 单分支）
        ttDomain.summary = { autoEnabled: true, intervalRounds: 3, keepRounds: 3, bigEvery: 3 };
        globalThis.fetch = baseFetch;
        const notEligible = await runSmallSummary({ auto: true });
        check('守卫：自动触发算术不达标跳过（aged 4 楼 < 间隔 3 轮）',
            notEligible.kind === 'skipped' && notEligible.reason.includes('算术不达标'),
            `reason=${notEligible.kind === 'skipped' ? notEligible.reason : notEligible.kind}`);
        // 任务模型未配置（小总结行悬空）
        mutateTaskProfiles(profiles => {
            profiles.summary_small = { providerId: 'no-such-endpoint', model: 'x' };
        });
        const noEndpoint = await runSmallSummary({ auto: false });
        check('守卫：任务模型未配置跳过（指引文案指向任务模型卡）',
            noEndpoint.kind === 'skipped' && noEndpoint.reason.includes('未配置总结模型'),
            `reason=${noEndpoint.kind === 'skipped' ? noEndpoint.reason : noEndpoint.kind}`);
        mutateTaskProfiles(profiles => {
            profiles.summary_small = { providerId: endpoint.id, model: 'summary-model' };
        });
        // 手动无可总结：aged 0（全部在保留窗口内）
        seedChat(4);
        const nothing = await runSmallSummary({ auto: false });
        check('守卫：手动无可总结楼层跳过（原文保留窗口口径文案）',
            nothing.kind === 'skipped' && nothing.reason.includes('没有可总结的楼层'),
            `reason=${nothing.kind === 'skipped' ? nothing.reason : nothing.kind}`);
        // 手动大总结：无小总结可合并
        const noMerge = await runBigSummary();
        check('守卫：无未折叠小总结时大总结跳过',
            noMerge.kind === 'skipped' && noMerge.reason.includes('没有未折叠的小总结'));

        // ---- 空白输出 fail：不动楼层与状态 ----
        globalThis.fetch = (async () => ({
            ok: true, status: 200,
            body: { getReader: () => {
                const encoder = new TextEncoder();
                const frames = [encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '  \n\t ' } }] })}\n\n`), encoder.encode('data: [DONE]\n\n')];
                return {
                    read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true },
                    cancel: async () => undefined,
                };
            } },
        })) as unknown as typeof fetch;
        seedChat(10);
        const blank = await runSmallSummary({ auto: false });
        check('守卫：空白输出 fail fast（isBlankResponseContent 单点判据、楼层与状态零改动）',
            blank.kind === 'failed' && blank.message.includes('未返回任何内容')
            && hiddenFloorCount() === 0 && readSummaryChatState().smallSummaries.length === 0,
            `kind=${blank.kind}`);

        // ---- e2e：完整小总结链（组装→请求→落账→隐藏→槽重挂）----
        globalThis.fetch = baseFetch;
        stubs.generateCalls.length = 0;
        const saveBefore = stubs.saveChatCalls;
        const done = await runSmallSummary({ auto: false });
        const call = stubs.generateCalls[stubs.generateCalls.length - 1];
        const lastRecord = useRunlogStore().records[useRunlogStore().records.length - 1];
        const messages = (call?.body.messages ?? []) as Array<{ role: string; content: string }>;
        const joined = messages.map(m => m.content).join('\n');
        check('e2e：完整小总结链落地（折叠 4 楼＝floor 0 开场白入批、落账区间 0-3、隐藏后 is_system 联动）',
            done.kind === 'small-done' && done.foldedFloors === 4 && done.bigRan === false
            && flags().filter(Boolean).length === 4
            && stubs.getContext().chat.slice(0, 4).every(m => m.is_system === true)
            && stubs.getContext().chat.slice(4).every(m => m.is_system !== true)
            && JSON.stringify(readSummaryChatState().smallSummaries) === JSON.stringify([{ text: SUMMARY_TEXT, fromFloor: 0, toFloor: 3 }]),
            `kind=${done.kind}`);
        check('e2e：槽重挂（IN_CHAT 位＋scan=true＋system 角色、小总结单节形态含批次行与正文）',
            slotState()?.position === 1 && slotState()?.depth === 10000 && slotState()?.scan === true && slotState()?.role === 0
            && (slotState()?.value ?? '').startsWith('以下是本对话更早剧情的压缩摘要')
            && (slotState()?.value ?? '').includes('【小总结·近期】')
            && (slotState()?.value ?? '').includes('【小总结·第1批｜约第1-4楼】')
            && (slotState()?.value ?? '').includes(SUMMARY_TEXT)
            && !(slotState()?.value ?? '').includes('【大总结】'),
            `value=${JSON.stringify(slotState()?.value.slice(0, 60) ?? '')}`);
        check('e2e：hide 落盘走 saveCurrentChat 通道（计数 +1）', stubs.saveChatCalls === saveBefore + 1, `delta=${stubs.saveChatCalls - saveBefore}`);
        check('e2e：请求形状（宿主路由、quiet、custom 源、端点身份、temperature 0.7、reasoning_effort high 按 client 实发形态、流式、prompt_only 无契约键、无 max_tokens）',
            call?.url === '/api/backends/chat-completions/generate'
            && call?.body.type === 'quiet' && call?.body.chat_completion_source === 'custom'
            && call?.body.reverse_proxy === 'https://summary-smoke.example.com/v1' && call?.body.proxy_password === 'sk-summary'
            && call?.body.model === 'summary-model'
            && call?.body.temperature === 0.7
            && call?.body.reasoning_effort === 'high'
            && call?.body.stream === true
            && !('response_format' in (call?.body ?? {})) && !('max_tokens' in (call?.body ?? {})),
            `body=${JSON.stringify(call?.body ?? {})}`);
        check('e2e：组装内容（任务指令＋summary_source 源文本逐楼 speaker 标注：user 楼【王玉】、AI 楼【林霜】）',
            joined.includes('剧情记录员') && joined.includes('【王玉】') && joined.includes('【林霜】')
            && joined.includes('用户第0楼：走到旧货铺门口。'),
            `messages=${messages.length}`);
        // runlog ring 上限 20（早期记录被裁剪）——长度不可比，判据锁末条记录的归属与成败
        check('e2e：runlog 记录 task=summary_small（RunTask SSOT 扩展生效）',
            lastRecord?.task === 'summary_small' && lastRecord?.ok === true, `task=${String(lastRecord?.task)} ok=${String(lastRecord?.ok)}`);
        // 成功落账后的取消信号不回滚（hide 启动后路径不可中断的落账侧证明）
        cancelSummaryGeneration();
        check('e2e：落账后取消信号不回滚已折叠楼层与总结态',
            hiddenFloorCount() === 4 && readSummaryChatState().smallSummaries.length === 1);

        // ---- 大总结级联：第 bigEvery 条小总结落账后触发、滚动替换清空 ----
        seedChat(10); // 新一段原料（落账区间 display-only 允许与前批重叠）
        const cascade1 = await runSmallSummary({ auto: false });
        check('级联：未攒满 bigEvery 不触发大总结（smallSummaries 继续累积）',
            cascade1.kind === 'small-done' && cascade1.bigRan === false && readSummaryChatState().smallSummaries.length === 2,
            `kind=${cascade1.kind}`);
        stubs.generateCalls.length = 0;
        seedChat(10);
        const cascade2 = await runSmallSummary({ auto: false }); // 第 3 条 → bigEvery=3 触发
        const bigCall = stubs.generateCalls[stubs.generateCalls.length - 1];
        const bigBody = bigCall?.body ?? {};
        const stateAfter = readSummaryChatState();
        check('级联：第 bigEvery 条落账后立即跑大总结（请求形状同 summary、bigSummary 替换、小总结群清空）',
            cascade2.kind === 'small-done' && cascade2.bigRan === true
            && bigCall?.url === '/api/backends/chat-completions/generate' && bigBody.temperature === 0.7
            && stateAfter.smallSummaries.length === 0 && stateAfter.bigSummary === SUMMARY_TEXT,
            `kind=${cascade2.kind} bigError=${cascade2.kind === 'small-done' ? cascade2.bigError ?? '' : ''}`);
        const bigMessages = ((bigBody.messages ?? []) as Array<{ content: string }>).map(m => m.content).join('\n');
        check('级联：大总结源文本带旧大总结节（缺席占位「（无）」）与小总结群节',
            bigMessages.includes('=== 旧大总结 ===') && bigMessages.includes('（无）') && bigMessages.includes('=== 近期小总结（按时间先后）==='));
        check('级联：大总结后槽重挂为大总结单节形态（小总结节省略）',
            (slotState()?.value ?? '').includes('【大总结】') && !(slotState()?.value ?? '').includes('【小总结·近期】'));
        // 手动大总结（有存货场景，与级联同判）
        writeSummaryChatState({ smallSummaries: [{ text: '待合并。', fromFloor: 0, toFloor: 1 }], bigSummary: '' });
        const manualBig = await runBigSummary();
        check('级联：手动大总结同判（合并后替换清空）',
            manualBig.kind === 'big-done' && readSummaryChatState().bigSummary === SUMMARY_TEXT && readSummaryChatState().smallSummaries.length === 0,
            `kind=${manualBig.kind}`);
        // 源文本构造纯函数（导出面直测）
        check('源文本：buildSmallSourceText 逐楼标注＋buildBigSourceText 分节（引擎侧零占位符转发）',
            buildSmallSourceText([msg('你好', { is_user: true }), msg('嗯。', { name: '阿樟' }), msg('（无名楼层）')]) === '【王玉】\n你好\n\n【阿樟】\n嗯。\n\n【林霜】\n（无名楼层）'
            && buildBigSourceText({ bigSummary: ' 旧 ', smallSummaries: [{ text: '甲' }, { text: '乙' }] }) === '=== 旧大总结 ===\n旧\n\n=== 近期小总结（按时间先后）===\n甲\n\n乙');
    } finally {
        globalThis.fetch = baseFetch;
        writeApiDomain(savedEndpoints);
        writeTaskProfiles(JSON.parse(savedProfilesJson) as TaskProfilesDomain);
        if (savedSettings === undefined) delete ttDomain.summary;
        else ttDomain.summary = savedSettings;
        // chat 域 summary 键冒烟前不存在——delete 还原缺席态（写空值会把
        // 键建出来，污染 boot2 重跑的起点）
        delete (smokeStubs().chat_metadata as { ttToolkit?: Record<string, unknown> }).ttToolkit?.summary;
        stubs.getContext().name1 = savedName1;
        stubs.getContext().name2 = savedName2;
        stubs.getContext().chat = [];
        delete stubs.getContext().extensionPrompts[SLOT_KEY];
    }
}

// ---------------------------------------------------------------------------
// 6) 事件接线（installSummaryAuto 的守卫分支＋CHAT_CHANGED 生命周期）
// ---------------------------------------------------------------------------

async function runAutoWiringChecks(): Promise<void> {
    const stubs = smokeStubs();
    const ttDomain = extension_settings.ttToolkit as Record<string, unknown>;
    const savedSettings = ttDomain.summary;
    const savedEndpoints = readApiDomain();
    const savedProfilesJson = JSON.stringify(readTaskProfiles());
    const baseFetch = globalThis.fetch;
    try {
        // 守卫分支（事件入口侧与 generator 守卫同判；基线设置缺席＝autoEnabled false）
        seedChat(10);
        check('接线：自动总结未开启时事件入口不触发', handleSummaryMessageReceived(9) === false);
        writeSummarySettings({ ...DEFAULT_SUMMARY_SETTINGS, autoEnabled: true, intervalRounds: 3, keepRounds: 3, bigEvery: 3 });
        check('接线：分组 chat_id（非数字 messageId）不当楼层触发', handleSummaryMessageReceived('12345') === false);
        seedChat(4); // raw 4 楼全在保留窗口内（keep 3 轮）
        check('接线：算术不达标时事件入口不触发', handleSummaryMessageReceived(3) === false);
        // CHAT_CHANGED 生命周期：abort in-flight → 自愈（翻回的 flag 楼重隐藏）→ 按聊天态重挂槽
        seedChat(8);
        hideFloors([0, 1]);
        stubs.getContext().chat[0].is_system = false; // 自愈间隙被外部翻回
        writeSummaryChatState({ smallSummaries: [{ text: '前情。', fromFloor: 0, toFloor: 1 }], bigSummary: '' });
        clearSummarySlot();
        installSummaryAuto();
        await stubs.eventSource.emit(event_types.CHAT_CHANGED);
        check('接线：CHAT_CHANGED 自愈重隐藏＋按聊天态重挂槽',
            stubs.getContext().chat[0]?.is_system === true && (slotState()?.value ?? '').includes('【小总结·近期】'));
        // 接线路径用的任务路由在本段起点就位：守卫链里任务模型检查排在错误正文检查
        // 之后，若路由缺席，下面的断言会因路由被拦而恒真（测不到错误正文判据）
        const endpoint = createEndpoint('接线冒烟服务商');
        endpoint.url = 'https://wiring-smoke.example.com/v1';
        endpoint.key = 'sk-wiring';
        endpoint.models = ['wiring-model'];
        writeApiDomain([endpoint]);
        seedTaskProfiles(endpoint.id, 'wiring-model');

        // 错误楼层跳过（宿主把生成失败伪装成正常回复落地，判据见 host/api-error.ts）：
        // 入口守卫拦「错误楼到达时触发」，源文本过滤拦「存量错误楼被后来某次批扫进来」。
        // 判别性：同配置（14 楼／keep 3／interval 3＝算术达标）下，错误楼在索引 2
        // 必被拦下，而本段末尾「达标场景」用例用同样的算术配置且返回 true——
        // 两者对照才证明拦下的原因确实是错误正文，而非算术/开关/端点巧合。
        seedChat(14);
        const errChat = stubs.getContext().chat as Array<Record<string, unknown>>;
        errChat[2] = { mes: '[API 错误]\n连接目标服务失败：当前网络、VPN、代理或接口地址可能暂时不可用。', is_user: true };
        const errFloorTriggered = handleSummaryMessageReceived(2);
        check('接线：错误正文楼层到达时自动触发被拦下（不把错误当剧情摘要）', errFloorTriggered === false);

        // 存量面：错误楼落在批次内时只折叠、不进摘要源文本
        stubs.generateCalls.length = 0;
        const errRun = await runSmallSummary({ auto: false });
        const errCall = stubs.generateCalls[stubs.generateCalls.length - 1];
        const errSource = ((errCall?.body.messages ?? []) as Array<{ content: string }>).map(m => m.content).join('\n');
        check('守卫：批次内错误正文楼不进摘要源文本（仍随批折叠，不产出假摘要）',
            errRun.kind === 'small-done'
            && !errSource.includes('连接目标服务失败')
            && errSource.includes('用户第0楼'),
            `kind=${errRun.kind} 含错误正文=${String(errSource.includes('连接目标服务失败'))}`);
        restoreAllFloors();
        // 本段落账会污染后续「达标触发」用例的起点（它断言 smallSummaries
        // 恰 1 条、折叠恰 8 楼）——按本文件既有纪律把 chat 域还原成缺席态，
        // 而非留个空壳键（写空值会把键建出来，污染 boot2 重跑起点）
        delete (stubs.chat_metadata as { ttToolkit?: Record<string, unknown> }).ttToolkit?.summary;
        clearSummarySlot();

        // fire 成功路径：达标场景经事件守卫触发 → fire-and-forget → 完成后互斥与 running 镜像归位
        seedChat(14); // raw 14 楼，keep 3 轮 → aged 8 楼 ≥ interval 3 轮（达标；同上面的算术配置）
        check('接线：达标场景事件入口返回 true 并启动后台生成', handleSummaryMessageReceived(13) === true);
        const settled = await waitFor(() => !isSummaryRunning());
        check('接线：自动生成完成后互斥归位＋楼层折叠落账＋running 镜像清位',
            settled && hiddenFloorCount() === 8 && readSummaryChatState().smallSummaries.length === 1 && useSummaryStore().runningKind === null);

        // ---- adaptive 事件感知：三相位接线＋askNow 节流＋CHAT_CHANGED 重置＋judge 缺席判否不崩＋强制线 ----
        restoreAllFloors();
        delete (stubs.chat_metadata as { ttToolkit?: Record<string, unknown> }).ttToolkit?.summary;
        clearSummarySlot();
        writeSummarySettings({ autoEnabled: true, intervalRounds: 3, keepRounds: 3, bigEvery: 3, triggerMode: 'adaptive', maxIntervalRounds: 8, judgeEveryRounds: 1 });
        seedChat(10); // aged 4 < 2×3：wait 相位
        stubs.generateCalls.length = 0;
        check('adaptive：不足最少间隔不询问也不总结',
            handleSummaryMessageReceived(9) === false && hiddenFloorCount() === 0 && stubs.generateCalls.length === 0);
        // 判断请求桩工厂：0.2/json_object 形状分发 → 回「否」；其余走原分发桩
        // （末段多周期复测要重装同款桩）
        const judgeStubFetch = (): typeof fetch => (async (_url: string | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            stubs.generateCalls.push({ url: String(_url), body });
            if (body.temperature === 0.2 && (body.response_format as { type?: string } | undefined)?.type === 'json_object') {
                return judgeSseResponse(JSON.stringify({ should_summarize: false, reason: '对话仍在同一场景中推进。' }));
            }
            return baseFetch(_url, init);
        }) as typeof fetch;
        globalThis.fetch = judgeStubFetch();
        seedChat(12); // aged 6：进入 judge 相位，本会话从未询问 → askNow
        check('adaptive：达最少间隔发判断请求而非直接总结（入口 true、无小总结启动）',
            handleSummaryMessageReceived(11) === true && !isSummaryRunning());
        await waitFor(() => stubs.generateCalls.length > 0);
        await waitFor(() => useRunlogStore().records[useRunlogStore().records.length - 1]?.task === 'summary_judge');
        const judgeCall = stubs.generateCalls[stubs.generateCalls.length - 1];
        const judgeMessages = (judgeCall?.body.messages ?? []) as Array<{ role: string; content: string }>;
        check('adaptive：judge 请求形状（温度 0.2、json_object 契约、custom 源、首条 system 即判断模板、无破限前缀混入）',
            judgeCall?.body.temperature === 0.2
            && (judgeCall?.body.response_format as { type?: string } | undefined)?.type === 'json_object'
            && judgeCall?.body.chat_completion_source === 'custom'
            && judgeMessages[0]?.role === 'system' && judgeMessages[0]?.content.startsWith('You are the summary timing judge')
            && judgeMessages.length === 2,
            `messages=${JSON.stringify(judgeMessages.map(m => m.role))}`);
        const judgeRecord = useRunlogStore().records[useRunlogStore().records.length - 1];
        check('adaptive：判断答否不总结（runlog task=summary_judge、楼层零折叠）',
            judgeRecord?.task === 'summary_judge' && judgeRecord?.ok === true
            && hiddenFloorCount() === 0 && readSummaryChatState().smallSummaries.length === 0);
        stubs.generateCalls.length = 0;
        check('adaptive：askNow 节流——judgeEvery 轮内不重问',
            handleSummaryMessageReceived(11) === false && stubs.generateCalls.length === 0);
        seedChat(14); // aged 8：距上次询问恰满 1 轮 → 再问
        stubs.generateCalls.length = 0;
        check('adaptive：隔满 judgeEvery 轮后重新询问',
            handleSummaryMessageReceived(13) === true);
        await waitFor(() => stubs.generateCalls.length > 0);
        // CHAT_CHANGED 重置询问节奏：同一询问点在切聊天后重新放行
        await stubs.eventSource.emit(event_types.CHAT_CHANGED);
        stubs.generateCalls.length = 0;
        check('adaptive：CHAT_CHANGED 重置询问节奏（同询问点重新放行）',
            handleSummaryMessageReceived(13) === true && !isSummaryRunning());
        await waitFor(() => stubs.generateCalls.length > 0);
        // judge 档案缺席：静默跳过本轮（不发请求、不崩）；force 路径不受影响由下段证明
        mutateTaskProfiles(profiles => {
            profiles.summary_judge = { providerId: '', model: '' };
        });
        await stubs.eventSource.emit(event_types.CHAT_CHANGED);
        stubs.generateCalls.length = 0;
        check('adaptive：judge 档案缺席判否不崩（静默跳过、不发请求）',
            handleSummaryMessageReceived(13) === false && stubs.generateCalls.length === 0);
        mutateTaskProfiles(profiles => {
            profiles.summary_judge = { providerId: endpoint.id, model: 'wiring-model' };
        });
        // force：达强制线不再询问直接总结
        globalThis.fetch = baseFetch;
        seedChat(22); // aged 16 ≥ 8×2：force 相位
        stubs.generateCalls.length = 0;
        check('adaptive：达强制线直接总结（不再询问）', handleSummaryMessageReceived(21) === true);
        const forceSettled = await waitFor(() => !isSummaryRunning());
        check('adaptive：强制总结落地（折叠 16 楼＋落账一条）',
            forceSettled && hiddenFloorCount() === 16 && readSummaryChatState().smallSummaries.length === 1,
            `hidden=${hiddenFloorCount()}`);

        // ---- 多周期复测：锚点跨折叠的纪元作废（Lead 修复的承重面） ----
        // 周期①（null 路径）：前段 CHAT_CHANGED 已清锚点，force 折叠后新
        // 周期首个询问点放行——证明折叠本身不禁问（非承重，承重在周期②）。
        globalThis.fetch = judgeStubFetch();
        seedChat(12); // aged 6：新周期 judge 相位
        stubs.generateCalls.length = 0;
        check('adaptive：折叠后新周期重新询问（null 锚点路径，judge 不静默）',
            handleSummaryMessageReceived(11) === true && !isSummaryRunning());
        await waitFor(() => stubs.generateCalls.length > 0);
        const cycleCall = stubs.generateCalls[stubs.generateCalls.length - 1];
        check('adaptive：新周期首问仍是判断请求（0.2/json_object 形状、无小总结折叠）',
            cycleCall?.body.temperature === 0.2
            && (cycleCall?.body.response_format as { type?: string } | undefined)?.type === 'json_object'
            && hiddenFloorCount() === 0,
            `temp=${String(cycleCall?.body.temperature)}`);
        // 周期①的询问已记账（锚点＝aged 6），答否不折叠——锚点带着进周期②。
        // 周期②（承重）：带锚点再 force 折叠一次（纪元推进、aged 归零）后
        // 攒回同一 aged 6——若锚点不随纪元作废，aged-lastAskedAged＝0 恒小于
        // judgeEvery×2，judge 永久静默；作废则按未询问放行（突变测试：删
        // auto.ts 纪元校验行本组必红）。
        seedChat(22); // aged 16 ≥ 8×2：force 相位
        stubs.generateCalls.length = 0;
        check('多周期②前置：带锚点场景下强制总结再次落地（纪元推进）',
            handleSummaryMessageReceived(21) === true && await waitFor(() => !isSummaryRunning())
            && hiddenFloorCount() === 16,
            `hidden=${hiddenFloorCount()}`);
        seedChat(12); // aged 6：回到与锚点相同的 aged 数值
        stubs.generateCalls.length = 0;
        check('adaptive：锚点跨折叠随纪元作废（同 aged 数值下仍放行询问，judge 不静默）',
            handleSummaryMessageReceived(11) === true && !isSummaryRunning());
        await waitFor(() => stubs.generateCalls.length > 0);
        const staleCall = stubs.generateCalls[stubs.generateCalls.length - 1];
        check('adaptive：锚点作废后的询问仍是判断请求（形状＋无新增折叠）',
            staleCall?.body.temperature === 0.2
            && (staleCall?.body.response_format as { type?: string } | undefined)?.type === 'json_object'
            && hiddenFloorCount() === 0,
            `temp=${String(staleCall?.body.temperature)}`);

        // ---- judge 落回竞态：询问挂起期间手动总结启动，落回 true 不得抢/清手动镜像 ----
        // 两条门（judgeGate/manualGate）把两个异步链精确卡住：判断请求挂起 →
        // 手动经 store 启动（镜像置位）→ 放行判断（答 true）→ 自动路径须被
        // fireSmallSummary 的 isSummaryRunning 防线拦下（无防线时 busy 立返
        // 后 finally endRun 会把手动镜像提前清位——突变测试的判别点）。
        let releaseJudge!: (r: Response) => void;
        const judgeGate = new Promise<Response>(resolve => { releaseJudge = resolve; });
        let releaseManual!: () => void;
        const manualGate = new Promise<void>(resolve => { releaseManual = resolve; });
        globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            stubs.generateCalls.push({ url: String(_url), body });
            if (body.temperature === 0.2 && (body.response_format as { type?: string } | undefined)?.type === 'json_object') {
                return judgeGate;
            }
            await manualGate; // 手动生成的请求挂起，等竞态窗口摆好再放
            return baseFetch(_url, init);
        }) as typeof fetch;
        seedChat(14); // aged 8：距锚点（aged 6）满 1 轮 → askNow
        stubs.generateCalls.length = 0;
        check('竞态前置：判断请求已发出并挂起（judgeGate 未放行）',
            handleSummaryMessageReceived(13) === true && !isSummaryRunning());
        await waitFor(() => stubs.generateCalls.length > 0);
        const store = useSummaryStore();
        const manual = store.runManualSmall();
        check('竞态前置：手动小总结经 store 置 running 镜像（判断仍在挂起）',
            store.runningKind === 'small' && isSummaryRunning());
        releaseJudge(judgeSseResponse(JSON.stringify({ should_summarize: true, reason: '段落收束。' })));
        for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); // 放行整条判断落回微任务链
        check('竞态：判断落回 true 不抢不动手动镜像（自动触发被防线拦下）',
            store.runningKind === 'small' && isSummaryRunning(),
            `runningKind=${String(store.runningKind)}`);
        releaseManual();
        await manual;
        // 手动落账恰使 smalls 攒满 bigEvery=3 → 级联大总结合并清空（既有
        // 行为，级联段已单测）；收口断言按级联后终态：镜像清位、折叠 8 楼、
        // 小总结并入大总结且无多余自动总结（多一场会 hidden>8 或镜像错乱）
        check('竞态收口：手动小总结正常落地并级联合并（镜像清位、折叠 8 楼、smalls 并入大总结）',
            store.runningKind === null && hiddenFloorCount() === 8
            && readSummaryChatState().smallSummaries.length === 0 && readSummaryChatState().bigSummary !== '',
            `hidden=${hiddenFloorCount()} smalls=${readSummaryChatState().smallSummaries.length} big=${readSummaryChatState().bigSummary.length}字`);
    } finally {
        writeApiDomain(savedEndpoints);
        writeTaskProfiles(JSON.parse(savedProfilesJson) as TaskProfilesDomain);
        if (savedSettings === undefined) delete ttDomain.summary;
        else ttDomain.summary = savedSettings;
        stubs.getContext().chat = [];
        // chat 域 summary 键本段起点为缺席——delete 还原（与 generation 段同纪律：
        // 写空值会把键建出来，污染 boot2 重跑的起点）
        delete (stubs.chat_metadata as { ttToolkit?: Record<string, unknown> }).ttToolkit?.summary;
        clearSummarySlot();
        delete stubs.getContext().extensionPrompts[SLOT_KEY];
    }
}

/** 冒烟入口（main.ts node 分支调用；排在 choice/persona smoke 之后——共享 stub 单例与 fetch 桩）。 */
export async function runSummarySmoke(): Promise<void> {
    console.info('=== summary 触发算术/状态机/槽组合/守卫链/端到端机判 ===');
    runArithmeticChecks();
    runSlotComposeChecks();
    runStateChecks();
    runNormalizeChecks();
    await runGenerationChecks();
    await runJudgeChecks();
    await runAutoWiringChecks();
    if (failures.length > 0) {
        console.error(`[summary-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[summary-smoke] OK：触发算术（fixed 相位回归/adaptive 三相位/askNow 节流/roundsToTrigger 同源）、normalize 钳制（含 triggerMode/强制线/询问间隔）、槽组合四形态逐字、状态机（hide/restore/selfHeal 的 flag×is_system 联动＋foldEpoch 推进）、守卫链（互斥/autoEnabled/算术/端点/无可总结/空白输出/取消边界零改动）、级联（bigEvery 触发＋滚动替换清空）、端到端完整链（组装 speaker 标注→请求形状 temperature 0.7＋reasoning_effort high→落账→隐藏→槽重挂）、判断器（解析三级/破限豁免/端到端好 JSON→判 true/窗口错误楼过滤/失败面判 null）、事件接线（守卫分支＋CHAT_CHANGED 自愈重挂＋adaptive 三相位接线/askNow 节流/会话态重置/judge 档案缺席判否不崩/强制线直接总结/折叠后新周期锚点作废再询问）全部通过。');
}
