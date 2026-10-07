/**
 * node 冒烟的 summary 机判部分：触发算术＋守卫链＋状态机＋槽组合
 * ＋完整链端到端（scripts/smoke.mjs 收口断言，与 choice/persona
 * smoke 同构：check() 打 [summary-smoke] PASS/FAIL 行）。
 *
 * 全部走 stub 宿主数据（chat 数组／端点表／dispatching fetch 桩），
 * 与浏览器真实数据共用同一条 generator/state/slot 代码路径。每段
 * 自清理：stub 单例跨段共享（boot2 重跑同段），不留 fixture 残留。
 */
import { extension_settings, type ChatMessage } from '@/host';
import { createEndpoint, readActiveEndpointId, readApiDomain, setActiveEndpointId, writeApiDomain } from '@/modules/apis/storage';
import { useRunlogStore } from '@/modules/runlog/store';
import { MAX_FLOORS_PER_RUN, planAutoSmallSummary, planManualSmallSummary, roundsToTrigger, shouldRunBigSummary } from './arithmetic';
import { buildBigSourceText, buildSmallSourceText, cancelSummaryGeneration, isSummaryRunning, restoreAllSummaries, runBigSummary, runSmallSummary } from './generator';
import { DEFAULT_SUMMARY_SETTINGS, normalizeSummaryChatState, normalizeSummarySettings, readSummaryChatState, writeSummaryChatState } from './settings';
import { clearSummarySlot, SLOT_KEY } from './slot';
import { composeSlotValue } from './slot-compose';
import { hiddenFloorCount, hideFloors, isRawFloor, isSummaryHiddenFloor, rawFloorIndices, restoreAllFloors, selfHealSummaryState } from './state';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
    console.info(`[summary-smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

interface SmokeStubs {
    getContext(): { chat: Array<Record<string, unknown>>; extensionPrompts: Record<string, { value: string; position: number; depth: number; scan: boolean; role: number }>; [key: string]: unknown };
    /** 聊天域写通道的物理挂载点（chat 域键的缺席态还原用）。 */
    chat_metadata: Record<string, unknown>;
    saveChatCalls: number;
    generateCalls: Array<{ url: string; body: Record<string, unknown> }>;
}

function smokeStubs(): SmokeStubs {
    return (globalThis as unknown as { __TT_SMOKE_STUBS__: SmokeStubs }).__TT_SMOKE_STUBS__;
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

// ---------------------------------------------------------------------------
// 1) 触发算术（纯函数：多组 interval/keep＋取偶＋上限＋级联条件＋同源换算）
// ---------------------------------------------------------------------------

function runArithmeticChecks(): void {
    const cases: Array<{ raw: number; interval: number; keep: number; eat: number; batch: number }> = [
        { raw: 14, interval: 3, keep: 3, eat: 8, batch: 8 },
        { raw: 12, interval: 3, keep: 3, eat: 6, batch: 6 },
        { raw: 10, interval: 3, keep: 3, eat: 4, batch: 0 }, // 4 < 2×3 不达标
        { raw: 13, interval: 1, keep: 3, eat: 6, batch: 6 }, // aged 7 向下取偶→6
        { raw: 4, interval: 3, keep: 3, eat: 0, batch: 0 },  // 全部在保留窗口内
        { raw: 200, interval: 3, keep: 3, eat: 194, batch: MAX_FLOORS_PER_RUN }, // 单次批上限，超出留池下次继续
        { raw: 30, interval: 1, keep: 1, eat: 28, batch: 28 },
    ];
    const allOk = cases.every(c => {
        const plan = planAutoSmallSummary(c.raw, c.interval, c.keep);
        return plan.eatCount === c.eat && plan.batchSize === c.batch;
    });
    check('算术：多组 interval/keep 下 agedCount/向下取偶/达标线/单次批上限留池', allOk,
        `实得=${JSON.stringify(cases.map(c => planAutoSmallSummary(c.raw, c.interval, c.keep)))}`);
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
    const savedActive = readActiveEndpointId();
    const ttDomain = extension_settings.ttToolkit as Record<string, unknown>;
    const savedSettings = ttDomain.summary;
    const endpoint = createEndpoint('summary冒烟端点');
    endpoint.url = 'https://summary-smoke.example.com/v1';
    endpoint.key = 'sk-summary';
    endpoint.model = 'summary-model';
    writeApiDomain([endpoint]);
    setActiveEndpointId(endpoint.id);
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
        // 端点缺席
        setActiveEndpointId('no-such-endpoint');
        const noEndpoint = await runSmallSummary({ auto: false });
        check('守卫：端点缺席跳过（指引文案与 choice 同口径）',
            noEndpoint.kind === 'skipped' && noEndpoint.reason.includes('未选择生成端点'));
        setActiveEndpointId(endpoint.id);
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
                return { read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true } };
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
        check('e2e：请求形状（宿主路由、quiet、端点身份、temperature 0.7、reasoning_effort low 按 client 实发形态、流式、prompt_only 无契约键、无 max_tokens）',
            call?.url === '/api/backends/chat-completions/generate'
            && call?.body.type === 'quiet' && call?.body.chat_completion_source === 'openai'
            && call?.body.reverse_proxy === 'https://summary-smoke.example.com/v1' && call?.body.proxy_password === 'sk-summary'
            && call?.body.model === 'summary-model'
            && call?.body.temperature === 0.7
            && call?.body.reasoning_effort === 'low'
            && call?.body.stream === true
            && !('response_format' in (call?.body ?? {})) && !('max_tokens' in (call?.body ?? {})),
            `body=${JSON.stringify(call?.body ?? {})}`);
        check('e2e：组装内容（任务指令＋summary_source 源文本逐楼 speaker 标注：user 楼【王玉】、AI 楼【林霜】）',
            joined.includes('剧情记录员') && joined.includes('【王玉】') && joined.includes('【林霜】')
            && joined.includes('用户第0楼：走到旧货铺门口。'),
            `messages=${messages.length}`);
        // runlog ring 上限 20（早期记录被裁剪）——长度不可比，判据锁末条记录的归属与成败
        check('e2e：runlog 记录 task=summary（RunTask 扩展生效）',
            lastRecord?.task === 'summary' && lastRecord?.ok === true, `task=${String(lastRecord?.task)} ok=${String(lastRecord?.ok)}`);
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
        setActiveEndpointId(savedActive);
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

/** 冒烟入口（main.ts node 分支调用；排在 choice/persona smoke 之后——共享 stub 单例与 fetch 桩）。 */
export async function runSummarySmoke(): Promise<void> {
    console.info('=== summary 触发算术/状态机/槽组合/守卫链/端到端机判 ===');
    runArithmeticChecks();
    runSlotComposeChecks();
    runStateChecks();
    runNormalizeChecks();
    await runGenerationChecks();
    if (failures.length > 0) {
        console.error(`[summary-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[summary-smoke] OK：触发算术（agedCount/取偶/上限留池/roundsToTrigger 同源）、槽组合四形态逐字、状态机（hide/restore/selfHeal 的 flag×is_system 联动）、normalize 钳制、守卫链（互斥/autoEnabled/算术/端点/无可总结/空白输出/取消边界零改动）、级联（bigEvery 触发＋滚动替换清空）、端到端完整链（组装 speaker 标注→请求形状 temperature 0.7＋reasoning_effort low→落账→隐藏→槽重挂）全部通过。');
}
