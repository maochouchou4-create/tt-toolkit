/**
 * node 冒烟的 choice 机判部分：组装纯函数路径＋解析回退确定性触发。
 *
 * 设计：直接驱动引擎纯函数（合成 AssemblySources——不依赖宿主在场
 * 数据，断言确定性），与浏览器真实数据共用同一条 assembleMessages/
 * parseOptions 代码路径（dist 加载即覆盖）。输出 PASS/FAIL 行供
 * scripts/smoke.mjs 收口断言。
 */
import { assembleMessages, createDefaultPromptConfig, renderDump, renderTraceCompact, type AssemblySources, type HistoryEntry, type PoolInjectionSupply } from '@/prompts';
import { buildGenerateBody, callGenerateEndpoint } from '@/modules/apis/client';
import { TASK_DEFAULTS } from '@/modules/apis/task-defaults';
import { useRunlogStore } from '@/modules/runlog/store';
import { createEndpoint, readActiveEndpointId, readApiDomain, setActiveEndpointId, writeApiDomain } from '@/modules/apis/storage';
import { DEBUG_MALFORMED_RAW, parseOptions } from './parse';
import { choiceStorage } from './api';
import { generateOptions } from './generator';
import { readFloorOptions, writeFloorOptions } from './persist';
import { useChoiceStore } from './store';
import { drawAmount, resolvePool, safeWeight } from './pool/resolver';
import type { PoolEntry } from './pool/types';
import { ASSET_POOL_VERSION, buildAssetPool, syncAssetPool } from './pool/asset';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
    console.info(`[choice-smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

function syntheticSources(): AssemblySources {
    const history: HistoryEntry[] = [
        { role: 'user', content: '「你昨晚去哪了？」我盯着她问。' },
        { role: 'assistant', content: '她垂下眼帘，手指绕着发梢：「就是……出去走了走而已。」' },
    ];
    return {
        persona: '王玉，28 岁的普通上班族，性格谨慎多疑。',
        charDescription: '林霜，表面温婉的同事，实则背负秘密。',
        charPersonality: '表面温和，回避直接冲突。',
        charScenario: '现代都市职场。',
        charName: '林霜',
        userName: '王玉',
        worldInfoBefore: '【公司】一栋老写字楼，午休时天台常有独处的人。',
        worldInfoAfter: '',
        worldInfoDepthBefore: '【三年前】她曾与斗篷人有过一面之缘。',
        worldInfoDepthAfter: '',
        history,
        storyDirection: { presetText: '让剧情围绕未解之谜展开，逐步加深悬念。', freeText: '重点描写她的回避态度' },
        externalSlots: [{ key: '1_memory', value: '此前剧情摘要：两人在酒馆发生过争执。' }],
        baibaiSummary: null,
        poolInjection: null,
        count: 4,
        minChars: 10,
        maxChars: 60,
    };
}

// ---------------------------------------------------------------------------
// 池机判：抽取 / 注入 / 绑定 / 自动生成
// ---------------------------------------------------------------------------

/**
 * 种子 PRNG（mulberry32 公通行实现）：分布断言要确定性复现——同一批种子
 * 重跑结果逐位一致，重权/轻权命中频次才是可机判的。
 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeEntry(id: string, weight: number, pinned: boolean, category = '默认'): PoolEntry {
    return { id, type: `选项${id}`, content: `${id}的行动正文`, category, pinned, weight };
}

/** 1) 抽取分布与数学（种子 PRNG 驱动 resolvePool 纯函数）。 */
function runPoolChecks(): void {
    // E-S 加权分布：1 条重权（5）对 7 条轻权（1），每轮抽 4。重权命中
    // 频次应显著高于任何单条轻权（每轮换种子——300 轮聚合抹平单轮波动）
    const heavy = makeEntry('heavy', 5, false);
    const lights = Array.from({ length: 7 }, (_, i) => makeEntry(`light${i}`, 1, false));
    const distPool = [heavy, ...lights];
    const ROUNDS = 300;
    let heavyHits = 0;
    const lightHits = new Array<number>(7).fill(0);
    for (let i = 0; i < ROUNDS; i++) {
        const result = resolvePool({ pool: distPool, count: 4, categoriesEnabled: false, pinnedOverflow: 'send_all', oversamplePct: 0, shuffleFinal: true, random: mulberry32(0xc0ffee + i) });
        if (result.drawn.some(e => e.id === heavy.id)) heavyHits++;
        lights.forEach((l, j) => {
            if (result.drawn.some(e => e.id === l.id)) lightHits[j]++;
        });
    }
    const maxLight = Math.max(...lightHits);
    check('抽取分布：重权条目命中频次显著高于轻权（E-S 加权，300 轮）', heavyHits > maxLight * 1.6 && heavyHits > ROUNDS * 0.6, `heavy=${heavyHits} maxLight=${maxLight}`);

    // pinned 恒在：send_all 策略下每轮必含全部 pinned
    const pinnedPool = [makeEntry('p1', 1, true), makeEntry('p2', 1, true), makeEntry('c1', 1, false), makeEntry('c2', 1, false)];
    let pinnedOk = true;
    for (let i = 0; i < 100; i++) {
        const result = resolvePool({ pool: pinnedPool, count: 4, categoriesEnabled: false, pinnedOverflow: 'send_all', oversamplePct: 0, shuffleFinal: true, random: mulberry32(0x1234 + i) });
        if (!result.pinned.some(e => e.id === 'p1') || !result.pinned.some(e => e.id === 'p2')) pinnedOk = false;
    }
    check('抽取分布：pinned 恒在结果（send_all 全发）', pinnedOk);

    // trim：pinned 超过 count 时打乱后截到 count
    const overPool = Array.from({ length: 5 }, (_, i) => makeEntry(`p${i}`, 1, true));
    let trimOk = true;
    for (let i = 0; i < 50; i++) {
        const result = resolvePool({ pool: overPool, count: 3, categoriesEnabled: false, pinnedOverflow: 'trim', oversamplePct: 0, shuffleFinal: true, random: mulberry32(0x5678 + i) });
        if (result.pinned.length !== 3) trimOk = false;
    }
    check('抽取分布：trim 策略把 pinned 截到 count', trimOk);

    // 抽取量数学：remaining＋ceil(remaining×pct/100)，封顶池大小；remaining=0 时不补抽
    check(
        '抽取数学：drawAmount＝remaining＋ceil(remaining×pct/100)（封顶池大小）',
        drawAmount(4, 100, 10) === 8 && drawAmount(4, 0, 10) === 4 && drawAmount(2, 150, 3) === 3 && drawAmount(0, 100, 10) === 0 && drawAmount(3, 1, 99) === 4,
        `样本：${[drawAmount(4, 100, 10), drawAmount(4, 0, 10), drawAmount(2, 150, 3), drawAmount(0, 100, 10), drawAmount(3, 1, 99)].join('/')}`,
    );

    // 分桶轮询：3 桶各 2 条、抽 6 → 覆盖桶数 ≥2（单桶垄断被轮询打散）
    const catPool = [
        makeEntry('a1', 5, false, '甲'), makeEntry('a2', 1, false, '甲'),
        makeEntry('b1', 1, false, '乙'), makeEntry('b2', 1, false, '乙'),
        makeEntry('c1', 1, false, '丙'), makeEntry('c2', 1, false, '丙'),
    ];
    let catOk = true;
    for (let i = 0; i < 10; i++) {
        const result = resolvePool({ pool: catPool, count: 6, categoriesEnabled: true, pinnedOverflow: 'send_all', oversamplePct: 0, shuffleFinal: true, random: mulberry32(0x9abc + i) });
        const buckets = new Set(result.drawn.map(e => e.category));
        if (buckets.size < 2) catOk = false;
    }
    check('分组轮询：候选覆盖多个 category 桶（≥2 桶）', catOk);

    // safeWeight 双复核 P3 回归：0/负权＝近零权（fork「实质禁用」语义），坏数据回等权
    check('safeWeight：0/负权压到近零、非数值回等权（fork 语义）', safeWeight(0) === safeWeight(-1) && safeWeight(0) < 1e-6 && safeWeight('x') === 1);
}

/**
 * 1.5) 池 asset（只读资产）：内置池静态形状＋syncAssetPool 行为机判。
 */
function runAssetPoolChecks(): void {
    // ---- 静态形状（纯函数，不依赖存储态）----
    const { masterPool } = buildAssetPool();
    check('asset：内置池 110 条（112−2 重复）', masterPool.length === 110, `实际 ${masterPool.length}`);
    const cats = new Set(masterPool.map(e => e.category));
    check('asset：整理后 17 个分类（20−3 合并）', cats.size === 17, `实际 ${cats.size}`);
    const transition = masterPool.find(e => e.type === '转场推进');
    check('asset：转场推进转固定（pinned）', !!transition && transition.pinned, `pinned=${String(transition?.pinned)}`);
    check('asset：无停用条目（引用层已删，条目自身 pinned/weight 即真值）', masterPool.every(e => e.weight > 0), `零/负权条目 ${masterPool.filter(e => e.weight <= 0).length}`);
    const ids = new Set(masterPool.map(e => e.id));
    check('asset：条目 id 确定性且唯一（asset-<序号>）', ids.size === masterPool.length && masterPool[0].id === 'asset-1', `唯一 ${ids.size}/${masterPool.length} 首条 ${masterPool[0]?.id}`);
    // 条目级 rule 字段已弃（v2 起移除，v3 连数据形状都不带）
    check('asset：条目规则字段移除（v3，数据形状不再含 rule）', masterPool.every(e => !('rule' in e)), `带 rule 条目 ${masterPool.filter(e => 'rule' in e).length}`);

    // ---- 同步行为（存储态驱动）----
    const resetPool = () => {
        choiceStorage.writeDomain(d => {
            d.pool = { masterPool: [] };
        });
    };
    // 首次同步：旧默认 false 被一次性翻转为 true（拍板：轮询默认开）
    resetPool();
    choiceStorage.updateGenParams({ categoriesEnabled: false });
    syncAssetPool();
    let domain = choiceStorage.readDomain();
    check('asset 首次同步：空池覆盖为 110 条并标记 assetVersion', domain.pool.masterPool.length === 110 && domain.pool.assetVersion === ASSET_POOL_VERSION, `条目 ${domain.pool.masterPool.length} v=${String(domain.pool.assetVersion)}`);
    check('asset 首次同步：categoriesEnabled 旧 false 翻转为 true', domain.gen.categoriesEnabled === true, `categoriesEnabled=${String(domain.gen.categoriesEnabled)}`);
    // 用户手动关：后续同步不得回翻（gen 纯用户域）
    choiceStorage.updateGenParams({ categoriesEnabled: false });
    syncAssetPool();
    domain = choiceStorage.readDomain();
    check('asset 幂等同步：用户关掉的轮询不被回翻', domain.gen.categoriesEnabled === false, `categoriesEnabled=${String(domain.gen.categoriesEnabled)}`);
    // 内容污染＋版本变更（assetVersion 指向旧版本）→ 同步全量恢复、不动 gen
    choiceStorage.writeDomain(d => {
        d.pool.masterPool.push({ id: 'smoke-junk', type: '垃圾', content: '应被覆盖', category: 'x', pinned: false, weight: 1 });
        d.pool.assetVersion = 0;
    });
    syncAssetPool();
    domain = choiceStorage.readDomain();
    check(
        'asset 版本变更：污染池全量恢复（垃圾清除、gen 不动）',
        domain.pool.masterPool.length === 110 && !domain.pool.masterPool.some(e => e.id === 'smoke-junk') && domain.pool.assetVersion === ASSET_POOL_VERSION && domain.gen.categoriesEnabled === false,
        `条目 ${domain.pool.masterPool.length} v=${String(domain.pool.assetVersion)}`,
    );
}

/** 3) 注入：pool_entries 模块的分区呈现与空态（池规则并入模板，独立段已删）。 */
function runInjectionChecks(): void {
    const config = createDefaultPromptConfig();
    const supply: PoolInjectionSupply = {
        pinned: [{ type: '检查酒馆', content: '仔细检查酒馆每个角落' }],
        drawn: [{ type: '打听消息', content: '向酒保打听传闻' }],
    };
    const result = assembleMessages(config.modules, { ...syntheticSources(), poolInjection: supply });
    const allText = result.messages.map(m => m.content).join('\n');

    check('池注入：pool_entries 段在场（固定/候选两区标签）', allText.includes('<pool_entries>') && allText.includes('【固定条目】') && allText.includes('【候选条目】'));
    check(
        '池注入：条目逐条渲染（type：content；规则概念已删，无 [规则: …] 后缀）',
        allText.includes('检查酒馆：仔细检查酒馆每个角落') && allText.includes('打听消息：向酒保打听传闻') && !allText.includes('[规则'),
    );
    check('池注入：菜单模式语义写进提示词文本（候选多于所需，AI 挑选）', allText.includes('数量多于实际所需') && allText.includes('贴合'));

    // P2-1 回归：pinned ≥ count 时固定条目声明覆盖语义（不再与「恰好 N 条」互斥）
    const overResult = assembleMessages(config.modules, { ...syntheticSources(), count: 1, poolInjection: supply });
    const overText = overResult.messages.map(m => m.content).join('\n');
    check(
        '池注入：pinned≥count 时显式声明数量覆盖（固定条目优先于恰好 N 条）',
        overText.includes('以固定条目为准') && overText.includes('不受数量规则限制'),
        `含覆盖句=${overText.includes('以固定条目为准')}`,
    );

    // 池规则不再独立注入——<pool_rules> 段缺席，反 OOC 要点
    // 整份写进模板 core_rules（<rules> 段），同一约束每请求只出现一份
    check(
        '池规则并入：无 <pool_rules> 独立段，反 OOC 要点在 <rules> 模板段',
        !allText.includes('<pool_rules>') && allText.includes('<rules>') && allText.includes('不得出现该角色不会说的话'),
    );

    const entTrace = result.trace.find(t => t.moduleId === 'inject_pool_entries');
    check('池注入：trace 留痕（固定 N 条、候选 M 条）', entTrace?.injected === true && entTrace.note.includes('固定 1 条、候选 1 条'), `note=${entTrace?.note ?? '（无 trace）'}`);
    check('池规则模块已从模板移除（trace 无 inject_pool_rules 条目）', !result.trace.some(t => t.moduleId === 'inject_pool_rules'));

    // 空态：null 供给＝池整体未启用；两区空＝池为空
    const nullResult = assembleMessages(config.modules, { ...syntheticSources(), poolInjection: null });
    const nullEnt = nullResult.trace.find(t => t.moduleId === 'inject_pool_entries');
    check('空池跳过＋trace note（无池数据＝池未启用）', nullEnt?.injected === false && nullEnt.note.includes('池未启用'), `note=${nullEnt?.note ?? '（无 trace）'}`);
    const emptyResult = assembleMessages(config.modules, { ...syntheticSources(), poolInjection: { pinned: [], drawn: [] } });
    const emptyEnt = emptyResult.trace.find(t => t.moduleId === 'inject_pool_entries');
    check('空引用跳过＋trace note（池为空）', emptyEnt?.injected === false && emptyEnt.note.includes('本聊天池为空'), `note=${emptyEnt?.note ?? '（无 trace）'}`);

    // dump 全文打印：smoke.mjs 的标记断言（<pool_entries>）在此收口
    console.info('=== 池注入 dump（默认模板＋池供给）===');
    console.info(renderDump(result));
}

/** 冒烟 stub 访问（scripts/smoke.mjs 注入；类型只声明本文件用到的面）。 */
interface SmokeStubs {
    eventSource: { emit(type: string, ...args: unknown[]): unknown };
    getContext(): { chat: unknown[] };
    saveChatCalls: number;
}

function smokeStubs(): SmokeStubs | null {
    return (globalThis as { __TT_SMOKE_STUBS__?: SmokeStubs }).__TT_SMOKE_STUBS__ ?? null;
}

/** 5) 自动生成：MESSAGE_RECEIVED 守卫链逐分支＋happy path fire-and-forget。 */
async function runAutoGenerateChecks(): Promise<void> {
    const stubs = smokeStubs();
    const store = useChoiceStore();
    if (!stubs) {
        check('自动生成：冒烟 stub 在场', false, '__TT_SMOKE_STUBS__ 缺席（应在浏览器宿主外由 smoke.mjs 注入）');
        return;
    }
    check('自动生成：冒烟 stub 在场', true);
    // 池态对齐真实启动：asset 同步在场（前序 asset 区结尾池=asset 全量）
    syncAssetPool();
    // 端点在场（池写面删除后无导入链落端点；stub fetch 在 smoke.mjs 注入）——
    // 记录原态（全局活动键必须在前置之前记录），收尾统一还原
    const savedEndpoints = readApiDomain();
    const savedActiveEndpointId = readActiveEndpointId();
    const smokeEndpoint = savedEndpoints[0] ?? createEndpoint('冒烟端点');
    if (savedEndpoints.length === 0) {
        writeApiDomain([smokeEndpoint]);
        setActiveEndpointId(smokeEndpoint.id);
    }
    // 清掉 debugForceRaw 遗留的会话态——跳过类断言的基准是「零选项、
    // phase 停在 idle」（跳过守卫不得触发任何生成）
    store.clearOptions();
    const emitReceived = (...args: unknown[]): unknown => stubs.eventSource.emit('message_received', ...args);

    // chat 供守卫链读楼层正文：idx0 开场白、idx1 空正文、idx2 真回复
    const chat = stubs.getContext().chat as Array<{ mes?: string; is_user?: boolean }>;
    chat.length = 0;
    chat.push(
        { mes: '（角色卡开场白楼层）', is_user: false },
        { mes: '', is_user: false },
        { mes: '这是 AI 的真实回复正文。', is_user: false },
    );

    emitReceived(2, 'quiet');
    check('自动生成：quiet 跳过', store.phase === 'idle' && store.options.length === 0);
    emitReceived(1, 'normal');
    check('自动生成：空文本跳过', store.phase === 'idle' && store.options.length === 0);
    // 错误正文跳过：宿主伪装成正常回复的失败正文（前缀判别）
    chat.push(
        { mes: '[API 错误]\n连接目标服务失败：当前网络、VPN、代理或接口地址可能暂时不可用。', is_user: false },
        { mes: '[API Error]\nCould not connect to the target service.', is_user: false },
    );
    emitReceived(3, 'normal');
    check('自动生成：错误正文跳过（zh-cn 同源标签命中）', store.phase === 'idle' && store.options.length === 0);
    emitReceived(4, 'normal');
    check('自动生成：错误正文跳过（英文硬编码兜底命中）', store.phase === 'idle' && store.options.length === 0);
    emitReceived(0, 'normal');
    check('自动生成：首楼（messageId===0）跳过', store.phase === 'idle' && store.options.length === 0);
    // 双复核 P3 回归：分组消息 (chat_id, type) 形态的纯数字串不当楼层索引
    emitReceived('2', 'normal');
    check('自动生成：非数字 messageId 跳过（分组 chat_id 形态不误判）', store.phase === 'idle' && store.options.length === 0);
    choiceStorage.updateGenParams({ autoGenerate: false });
    emitReceived(2, 'normal');
    check('自动生成：autoGenerate=false 跳过', store.phase === 'idle' && store.options.length === 0);
    choiceStorage.updateGenParams({ autoGenerate: true });

    // 无端点：全局活动键悬空 → resolveChoiceEndpoint null → console.warn（不弹 UI）
    setActiveEndpointId('no-such-endpoint');
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warns.push(args.map(String).join(' '));
    };
    emitReceived(2, 'normal');
    console.warn = origWarn;
    check('自动生成：端点未选 console.warn 跳过（不弹 UI）', store.phase === 'idle' && warns.some(w => w.includes('自动生成跳过') && w.includes('未选择生成端点')), `warns=${warns.length}`);
    setActiveEndpointId(smokeEndpoint.id);

    // happy path：同步返回（emit 返回时生成已启动但远未完成——fire-and-forget 实证）
    const returned = emitReceived(2, 'normal');
    check('自动生成：happy path 同步返回且生成启动（fire-and-forget）', returned === true && store.phase === 'running', `returned=${String(returned)} phase=${store.phase}`);
    // 生成中二次触发：并发锁（isGenerating）拦下
    const second = emitReceived(2, 'normal');
    check('自动生成：生成中二次触发被并发锁拦下', second === false, `second=${String(second)}`);

    // 等后台生成收尾（stub fetch 回固定 JSON；上限 2s 防 hang）
    for (let i = 0; i < 100 && store.phase === 'running'; i++) {
        await new Promise(r => setTimeout(r, 20));
    }
    check('自动生成：stub 端点回固定 JSON → 解析 4 条（json 主路径）', store.phase === 'idle' && store.options.length === 4 && store.lastParsePath === 'json', `phase=${store.phase} count=${store.options.length} path=${store.lastParsePath} error=${store.error}`);
    // 生成管线现场抽取池：drawPoolInjection 直吃 asset 全量池（pinned 条目必发；
    // 条目渲染无规则后缀）
    check('自动生成：生成管线现场抽取池（dump 必发条目可见）', store.lastDump.includes('<pool_entries>') && store.lastDump.includes('转场推进：用一两句精炼的叙述完成时间跳跃或地点切换，快速进入下一段剧情') && !store.lastDump.includes('[规则:'));
    // 外部注入全自动链路（stub context 槽位 → sources
    // 自动收集 → engine → dump）。stub_memory 先插入但 depth 4、
    // stub_anchor 后插入但 depth 0——排序断言只有真的按 depth 升序排
    // 才绿；stub_blank 空白 value＝「非空即带」的空槽位跳过面
    const slotIdx = (key: string): number => store.lastDump.indexOf(`[槽位 ${key}]`);
    check('自动生成：外部注入全自动（非空槽位搬入可见、空白槽位跳过）', slotIdx('stub_anchor') >= 0 && slotIdx('stub_memory') >= 0 && slotIdx('stub_blank') < 0, `anchor=${slotIdx('stub_anchor')} memory=${slotIdx('stub_memory')} blank=${slotIdx('stub_blank')}`);
    check('自动生成：外部注入槽位顺序对齐宿主 depth 升序（浅位在前）', slotIdx('stub_anchor') < slotIdx('stub_memory'), `anchor=${slotIdx('stub_anchor')} memory=${slotIdx('stub_memory')}`);
    // 柏宝书在场即带（自动口径）：STBaiBaiBook stub（smoke.mjs 注入
    // globalThis）→ getBaibaiSummary 优先注入口径 → <past_events> 段可见
    check('自动生成：柏宝书在场即带（摘要注入 <past_events> 段）', store.lastDump.includes('<past_events>') && store.lastDump.includes('【柏宝书·stub】'), 'stub getInjectedHistory 链路');

    // 还原端点原态（全局活动键还原前置前记录的原值——含「未选」空串；
    // 本区自落的冒烟端点与选中态不留残）
    setActiveEndpointId(savedActiveEndpointId);
    if (savedEndpoints.length === 0) {
        writeApiDomain([]);
    }
}

/**
 * 楼层落盘机判（消息级持久化 §用户可见行为 ①–⑧）：
 * roundtrip/落盘通道/刷新恢复/切聊天/重 roll 作废/swipe 跟随/删楼
 * 重载/写侧守门/坏档回退。事件驱动走 stub eventSource（与浏览器
 * eventBus 同一条订阅链路）。
 */
async function runFloorPersistChecks(): Promise<void> {
    const stubs = smokeStubs();
    const store = useChoiceStore();
    if (!stubs) {
        check('楼层落盘：冒烟 stub 在场', false, '__TT_SMOKE_STUBS__ 缺席（应在浏览器宿主外由 smoke.mjs 注入）');
        return;
    }
    check('楼层落盘：冒烟 stub 在场', true);
    const context = stubs.getContext();
    const emit = (type: string, ...args: unknown[]): unknown => stubs.eventSource.emit(type, ...args);
    const savedActiveEndpointId = readActiveEndpointId();

    interface FakeMessage { mes?: string; is_user?: boolean; is_system?: boolean; extra?: Record<string, unknown>; }
    const msg = (mes: string, extra?: Record<string, unknown>): FakeMessage => ({ mes, is_user: false, extra });
    const choiceExtra = (options: Array<{ title: string; content: string }>, parsePath = 'json'): Record<string, unknown> => ({
        ttToolkit: { choice: { options, parsePath } },
    });

    // ① 楼层级 roundtrip（机制底座）＋② 落盘通道确实被调用
    const chat1: FakeMessage[] = [msg('（角色卡开场白楼层）'), msg('AI 的真实回复正文。')];
    context.chat = chat1;
    const optsA = [{ title: '甲', content: '做甲事' }];
    const callsBefore = stubs.saveChatCalls;
    check('楼层落盘：writeFloorOptions 写入并返回 true', writeFloorOptions(1, optsA, 'json') === true);
    check('楼层落盘：写入触发 getContext().saveChat 落盘通道（计数 +1）', stubs.saveChatCalls === callsBefore + 1, `calls=${stubs.saveChatCalls}`);
    const readBack = readFloorOptions(1);
    check(
        '楼层落盘：roundtrip 读回一致（options 逐字段＋parsePath）',
        !!readBack && readBack.parsePath === 'json' && readBack.options.length === 1 && readBack.options[0]?.title === '甲' && readBack.options[0]?.content === '做甲事',
        `read=${JSON.stringify(readBack)}`,
    );

    // ③ 刷新后选项还在：清空 store 状态 → 同一 chat 按楼层重新 restore
    store.$reset();
    store.restore(1);
    check('楼层落盘：刷新模拟（清 store 后按楼层 restore）选项与解析路径恢复', store.options.length === 1 && store.options[0]?.title === '甲' && store.lastParsePath === 'json', `count=${store.options.length} path=${store.lastParsePath}`);

    // ④ 切聊天显示该聊天自己的选项；无存档＝空态
    const chat2: FakeMessage[] = [msg('（另一聊天开场白）'), msg('另一聊天的回复')];
    context.chat = chat2;
    writeFloorOptions(1, [{ title: '乙', content: '做乙事' }], 'bracket_fallback');
    emit('chat_id_changed');
    check('楼层落盘：切聊天后装载新聊天自己的选项（emit CHAT_CHANGED）', store.options.length === 1 && store.options[0]?.title === '乙' && store.lastParsePath === 'bracket_fallback' && store.floorIndex === 1, `title=${store.options[0]?.title} idx=${store.floorIndex}`);
    context.chat = [msg('（无存档聊天开场白）'), msg('无存档楼层')];
    emit('chat_id_changed');
    check('楼层落盘：切到无存档聊天＝空态', store.options.length === 0 && store.lastParsePath === '');

    // ⑤ 重 roll／重新生成后旧选项作废（核心行为）
    context.chat = chat1;
    emit('chat_id_changed');
    check('楼层落盘：切回原聊天恢复原存档（⑤前置）', store.options.length === 1 && store.options[0]?.title === '甲');
    // 成功路径：完整生成管线（debugForceRaw 无网络依赖）——生成开始清旧档、
    // 成功后新档＝本轮解析结果
    choiceStorage.updateGenParams({ debugForceRaw: true });
    try {
        await generateOptions();
    } finally {
        choiceStorage.updateGenParams({ debugForceRaw: false });
    }
    const afterRegen = readFloorOptions(1);
    check(
        '楼层落盘：重 roll 重新生成后旧选项作废（旧档被清、新档＝本轮生成结果、UI 跟随）',
        !!afterRegen && afterRegen.options.length === 4 && !afterRegen.options.some(o => o.title === '甲') && store.options.length === 4 && store.lastParsePath === 'bracket_fallback',
        `oldGone=${String(!afterRegen?.options.some(o => o.title === '甲'))} ui=${store.options.length}`,
    );
    // 失败路径：请求未发出（端点缺失）——生成开始已清档，该楼保持无选项态
    writeFloorOptions(1, optsA, 'json');
    setActiveEndpointId('no-such-endpoint');
    try {
        await generateOptions();
    } finally {
        setActiveEndpointId(savedActiveEndpointId);
    }
    check(
        '楼层落盘：生成失败路径旧档已清且不写新档（UI 空态、无残留）',
        readFloorOptions(1) === null && store.options.length === 0 && store.phase === 'error',
        `stored=${JSON.stringify(readFloorOptions(1))} phase=${store.phase}`,
    );
    store.$reset();

    // ⑤′ swipe 后选项跟随：宿主 syncSwipeToMes 用 swipe 槽 extra 整体替换
    chat1[1] = { mes: 'swipe 后正文', is_user: false, extra: choiceExtra([{ title: '丙', content: '做丙事' }]) };
    emit('message_swiped');
    check(
        '楼层落盘：swipe 换槽后选项跟随新 swipe 槽的 extra（emit MESSAGE_SWIPED）',
        store.options.length === 1 && store.options[0]?.title === '丙' && store.floorIndex === 1,
        `title=${store.options[0]?.title} idx=${store.floorIndex}`,
    );

    // ⑥ 删楼后重载（索引左移正确性）
    const delChat: FakeMessage[] = [msg('（开场白）'), msg('甲楼', choiceExtra([{ title: '丁', content: '做丁事' }])), msg('乙楼')];
    context.chat = delChat;
    emit('message_deleted');
    check('楼层落盘：删楼事件重载（无存档末楼＝空态）', store.options.length === 0 && store.floorIndex === 2);
    delChat.pop();
    emit('message_deleted');
    check('楼层落盘：删末楼后按新末楼装载（索引左移不错位）', store.options.length === 1 && store.options[0]?.title === '丁' && store.floorIndex === 1, `title=${store.options[0]?.title} idx=${store.floorIndex}`);
    delChat.splice(1);
    emit('message_deleted');
    // 开场白楼也是 assistant 楼（is_user=false）——剩开场白＝按 0 楼装载空态
    check('楼层落盘：删到仅剩开场白＝按开场白楼装载空态（不再回退无归属）', store.options.length === 0 && store.floorIndex === 0, `idx=${store.floorIndex}`);

    // ⑦ 写侧守门：越界与写前对象校验
    check('楼层落盘：写越界楼层返回 false 且不抛', writeFloorOptions(99, optsA, 'json') === false && writeFloorOptions(-1, optsA, 'json') === false);
    const foreign = msg('别的消息对象');
    const mismatchCalls = stubs.saveChatCalls;
    check(
        '楼层落盘：写前对象校验（索引处已换成别的消息对象）拒绝写入且不触发落盘',
        writeFloorOptions(0, optsA, 'json', undefined, foreign) === false && readFloorOptions(0) === null && stubs.saveChatCalls === mismatchCalls,
        `calls=${stubs.saveChatCalls}`,
    );

    // ⑧ 读侧坏档回退 null
    context.chat = [msg('坏档楼', { ttToolkit: { choice: { options: '不是数组', parsePath: 'json' } } })];
    check('楼层落盘：坏档（options 非数组）回退 null', readFloorOptions(0) === null);
    context.chat = [msg('坏档楼', { ttToolkit: { choice: { options: [{ title: 1, content: 'x' }], parsePath: 'json' } } })];
    check('楼层落盘：坏档（options 元素形状不符）回退 null', readFloorOptions(0) === null);
    context.chat = [msg('坏档楼', { ttToolkit: { choice: { options: [], parsePath: 'nope' } } })];
    check('楼层落盘：坏档（parsePath 非法枚举）回退 null', readFloorOptions(0) === null);

    // partial 路径存档 roundtrip：白名单放行（漏登记＝该路径存档被当坏档丢弃）
    context.chat = [msg('（开场白）'), msg('partial 楼')];
    const partialWritten = writeFloorOptions(1, optsA, 'partial', 2);
    const partialBack = readFloorOptions(1);
    check(
        '楼层落盘：partial 路径存档 roundtrip 读回（白名单放行，不判坏档）',
        partialWritten === true && !!partialBack && partialBack.parsePath === 'partial' && partialBack.options.length === 1,
        `written=${String(partialWritten)} read=${JSON.stringify(partialBack)}`,
    );
    check(
        '楼层落盘：丢弃计数随存档 roundtrip 写入读回（写侧链路端到端）',
        partialBack?.dropped === 2,
        `dropped=${String(partialBack?.dropped)}`,
    );
    // dropped 在场必须是数字（缺席合法——旧档兼容已有专项断言）
    context.chat = [msg('坏档楼', { ttToolkit: { choice: { options: [{ title: '甲', content: '做甲事' }], parsePath: 'partial', dropped: '两' } } })];
    check('楼层落盘：坏档（dropped 在场非数字）回退 null', readFloorOptions(0) === null);

    // 旧档兼容：无计数字段的存量形状（{options, parsePath}）读回成功，
    // 升级不把既有选项判坏档清空
    context.chat = [msg('旧档楼', { ttToolkit: { choice: { options: [{ title: '旧', content: '旧档正文' }], parsePath: 'json' } } })];
    const legacyBack = readFloorOptions(0);
    check(
        '楼层落盘：无计数字段的旧档形状读回成功（升级不判坏档清空）',
        legacyBack !== null && legacyBack.parsePath === 'json' && legacyBack.options[0]?.title === '旧',
        `read=${JSON.stringify(legacyBack)}`,
    );
}

/** 组装纯函数路径机判（默认模板集＋合成源）。 */
function runAssemblyChecks(): string {
    const config = createDefaultPromptConfig();
    const sources = syntheticSources();
    const result = assembleMessages(config.modules, sources);

    const allText = result.messages.map(m => m.content).join('\n');

    // dump 断言核心：各注入逐项可见
    check('人设注入可见（<persona> 段含 persona 正文）', allText.includes('<persona>') && allText.includes('王玉，28 岁'));
    check('角色卡描述注入可见（<character> 段）', allText.includes('<character>') && allText.includes('林霜，表面温婉'));
    check('角色卡性格注入可见（<personality> 段）', allText.includes('表面温和，回避直接冲突'));
    check('角色卡场景注入可见（<scenario> 段）', allText.includes('现代都市职场'));
    check('世界书前插注入可见（<world_info> 段）', allText.includes('一栋老写字楼'));
    check('世界书深度桶（深组）注入可见', allText.includes('【三年前】'));
    check('聊天历史注入（末条 AI 楼层 <current_scene> 包裹）', allText.includes('<current_scene>') && allText.includes('她垂下眼帘'));
    check('story_direction 注入可见（<direction> 段＝预设正文＋自由文本拼接）', allText.includes('<direction>') && allText.includes('未解之谜') && allText.includes('重点描写她的回避态度'));
    // 走向形态：自由文本为主＋预设拼接；两者皆空＝模块按未启用处理
    const emptyDirection = assembleMessages(config.modules, { ...sources, storyDirection: { presetText: '', freeText: '' } });
    const emptyDirTrace = emptyDirection.trace.find(t => t.moduleId === 'inject_story_direction');
    check('story_direction 两者皆空＝不注入（trace 留痕）', emptyDirTrace?.injected === false && emptyDirTrace.note.includes('未设置'), `note=${emptyDirTrace?.note ?? '（无 trace）'}`);
    const freeOnlyDirection = assembleMessages(config.modules, { ...sources, storyDirection: { presetText: '', freeText: '重点描写她的回避态度' } });
    const freeOnlyText = freeOnlyDirection.messages.map(m => m.content).join('\n');
    check('story_direction 仅自由文本也注入（无预设可用）', freeOnlyText.includes('<direction>') && freeOnlyText.includes('重点描写她的回避态度') && !freeOnlyText.includes('未解之谜'));
    // 自动口径（无开关无勾选）：baibai 合成源传 null
    // （插件缺席/接口异常形态）→ trace 记录未注入原因（缺席的可观测性）
    const baibaiTrace = result.trace.find(t => t.moduleId === 'inject_baibai');
    check('柏宝书摘要缺席＝不注入且 trace 留痕', baibaiTrace?.injected === false && baibaiTrace.note.includes('不可用'), `note=${baibaiTrace?.note ?? '（无 trace）'}`);
    // 外部槽位：合成源给了非空槽位内容 → 注入可见（非空即带单步链路）。
    // 逐槽位标注：内容段带槽位 key 前缀、trace note 同粒度（逐项可见到槽位）
    check('外部注入槽位搬入可见（<external_memory> 段逐槽位标注）', allText.includes('<external_memory>') && allText.includes('[槽位 1_memory]') && allText.includes('两人在酒馆发生过争执'));
    const injectedExtTrace = result.trace.find(t => t.moduleId === 'inject_external_slot');
    check('外部槽位 trace 注记到槽位粒度', injectedExtTrace?.injected === true && injectedExtTrace.note.includes('1_memory'), `note=${injectedExtTrace?.note ?? '（无 trace）'}`);
    // 自动口径的另一侧：无槽位供给（没有插件写入公共注入区）→ 段缺席
    // 不报错、trace 留痕（兼容不了就什么都不带——最近几轮聊天记录兜底）
    const noSlot = assembleMessages(config.modules, { ...sources, externalSlots: [] });
    const noSlotTrace = noSlot.trace.find(t => t.moduleId === 'inject_external_slot');
    const noSlotText = noSlot.messages.map(m => m.content).join('\n');
    check('外部槽位无供给＝段缺席不报错（trace 留痕）', !noSlotText.includes('<external_memory>') && noSlotTrace?.injected === false && noSlotTrace.note.includes('无可用槽位'), `note=${noSlotTrace?.note ?? '（无 trace）'}`);
    check('占位符替换（{{user}}/{{char}}/{{count}}）', !allText.includes('{{user}}') && !allText.includes('{{char}}') && !allText.includes('{{count}}') && allText.includes('王玉') && allText.includes('林霜'));
    // G2 视角口径：规则/few-shot/指令三层全部第三人称混合视角
    check('写作规则含三种推进视角（用户行动/角色主动/场景事件）', allText.includes('场景层面的事件发展') && allText.includes('主动行为或反应'));
    // 平行分支口径：同一刻的多种走法，彼此不互为前情（防递进式串联）。
    // 三层同锁：规则 5（禁令）＋few-shot 引导句（示范层）＋任务指令（收尾层）
    // ——只锁一层时另两层被改回串联形态不会翻红
    check('写作规则＝同一刻的平行分支（各走一路、不互为前情）',
        allText.includes('此刻同时摆开') && allText.includes('不互为因果') && allText.includes('不得被当成另一条的前情'),
        `平行口径=${allText.includes('此刻同时摆开')}`);
    check('平行口径三层同锁（规则/示例/指令）且旧措辞清零',
        allText.includes('各走一路') && allText.includes('并排的') && !allText.includes('角度错开'),
        `示例层=${allText.includes('各走一路')} 指令层=${allText.includes('并排的')}`);
    check('第三人称硬约束在场（用角色名或他／她）', allText.includes('第三人称') && allText.includes('不用「你」'));
    check('旧用户视角措辞清零', !allText.includes('以用户视角写') && !allText.includes('只写'));
    check('few-shot 旧三条仍在（反客为主/骤然断电）', allText.includes('反客为主') && allText.includes('骤然断电'));
    // few-shot 7 条（真人反应类型覆盖）
    const fewShot = config.modules.find(m => m.id === 'few_shot');
    const fewShotCount = fewShot && fewShot.kind === 'text' ? (fewShot.content.match(/"title":/g) ?? []).length : 0;
    check('few-shot 扩为 7 条真人反应示例（岔开/回避/反将一军/幽默化解等）', fewShotCount === 7, `条数=${fewShotCount}`);
    check('生成指令口径＝下一步的行动选项/可选的推进方向（task 与指令去重后）', allText.includes('下一步的行动选项') && allText.includes('可选的推进方向') && !allText.includes('为当前剧情提供'));
    check('任务指令收尾为 user 角色', result.messages[result.messages.length - 1]?.role === 'user');
    check('trace 全模块覆盖', result.trace.length === config.modules.length);

    // 外部槽位注入单步链路已由上方「非空即带」覆盖；再验证模块级启停
    // 开关的优先权：关掉 external 模块后即便 sources 供给也不注入
    // （modules[].enabled 保留的实证——引擎行为面，非 UI 面）
    const modulesOff = config.modules.map(m => (m.id === 'inject_external_slot' ? { ...m, enabled: false } : m));
    const offResult = assembleMessages(modulesOff, sources);
    const extTrace = offResult.trace.find(t => t.moduleId === 'inject_external_slot');
    check('模块开关优先（关掉后不注入）', extTrace?.injected === false, `note=${extTrace?.note ?? '（无 trace）'}`);

    const traceText = renderTraceCompact(result);
    console.info(`[choice-smoke] trace: ${traceText}`);
    return renderDump(result);
}

// ---------------------------------------------------------------------------
// 元素级恢复夹具：实锤截断形态的脱敏重写——只保字节级结构（同样的
// "key": "value" 空格风格、同样的多元素换行缩进），中文正文一律换成
// 中性合成内容（真实输出原文不入库）
// ---------------------------------------------------------------------------

/** 缺容器收口：5 个元素全部闭合完整、只缺收尾 ]}。 */
const PARTIAL_UNCLOSED_RAW = [
    '{"options": [',
    '    {"title": "甲", "content": "甲的行动正文，走向河边的旧渡口。"},',
    '    {"title": "乙", "content": "乙的行动正文，转身返回议事厅。"},',
    '    {"title": "丙", "content": "丙的行动正文，在原地等到天黑。"},',
    '    {"title": "丁", "content": "丁的行动正文，悄悄跟随那名商人。"},',
    '    {"title": "戊", "content": "戊的行动正文，向守卫出示信物。"}',
].join('\n');

/** 句中被掐断：前 4 个元素完整、第 5 个只剩半截。 */
const PARTIAL_MID_CUT_RAW = [
    '{"options": [',
    '    {"title": "甲", "content": "甲的行动正文，走向河边的旧渡口。"},',
    '    {"title": "乙", "content": "乙的行动正文，转身返回议事厅。"},',
    '    {"title": "丙", "content": "丙的行动正文，在原地等到天黑。"},',
    '    {"title": "丁", "content": "丁的行动正文，悄悄跟随那名商人。"},',
    '    {"title": "己", "content": "己的行动正',
].join('\n');

/** 解析回退确定性触发机判。 */
function runParseChecks(): void {
    // 调试畸形样本：思维链前缀＋括号格式 → 确定性走括号回退
    const report = parseOptions(DEBUG_MALFORMED_RAW, 4);
    check('畸形样本走回退路径（bracket_fallback）', report.path === 'bracket_fallback', `path=${report.path}`);
    check('畸形样本解析出 4 条', report.options.length === 4, `count=${report.options.length}`);
    check('畸形样本标题解析（首条＝推开酒馆的门）', report.options[0]?.title === '推开酒馆的门', `title=${report.options[0]?.title}`);
    check('畸形样本正文解析（首条含推开动作）', (report.options[0]?.content ?? '').includes('推开那扇厚重的木门'), `content=${report.options[0]?.content}`);
    check('【】混用标题解析（查看告示牌）', report.options.some(o => o.title === '查看告示牌'));

    // 尾随逗号 JSON：修复后走主路径（裸数组＝容错路径，兼容旧契约输出）
    const trailingJson = '[{"title":"A","content":"甲",}, {"title":"B","content":"乙"},]';
    const jsonReport = parseOptions(trailingJson, 4);
    check('尾随逗号 JSON 修复走主路径（json，裸数组容错）', jsonReport.path === 'json' && jsonReport.options.length === 2, `path=${jsonReport.path} count=${jsonReport.options.length}`);

    // 代码围栏包裹的 JSON
    const fenced = '```json\n[{"title":"A","content":"甲"}]\n```';
    const fencedReport = parseOptions(fenced, 4);
    check('代码围栏剥离后走主路径', fencedReport.path === 'json' && fencedReport.options.length === 1, `path=${fencedReport.path}`);

    // 对象契约（主契约形态：与 json_object 档「输出必须是对象」对齐）
    const wrapped = '{"options":[{"title":"A","content":"甲"}]}';
    const wrappedReport = parseOptions(wrapped, 4);
    check('对象契约 {"options":[...]} 走主路径', wrappedReport.path === 'json' && wrappedReport.options.length === 1, `path=${wrappedReport.path}`);

    // 空输入
    const empty = parseOptions('', 4);
    check('空输入解析为 empty', empty.path === 'empty' && empty.options.length === 0);

    // 标签堆叠（同一条选项内出现第二个括号不切分）
    const stacked = '[回溯闪回]🎞️ [记忆片段] 正文内容在这里';
    const stackedReport = parseOptions(stacked, 4);
    check('标签堆叠不切分（1 条而非 2 条）', stackedReport.options.length === 1, `count=${stackedReport.options.length}`);

    // ---- 元素级恢复（partial 路径）----
    // 缺容器收口（中转站宣告「说完了」却少写收尾 ]} 的实锤形态）：
    // 5 条全恢复、无丢弃、标题逐一匹配、首条 content 含已知子串
    const unclosedReport = parseOptions(PARTIAL_UNCLOSED_RAW, 5);
    check(
        '元素级恢复：缺容器收口（5 元素完整）→ partial 恢复 5 条无丢弃、标题逐一匹配、首条正文在场',
        unclosedReport.path === 'partial' && unclosedReport.options.length === 5 && unclosedReport.dropped === 0
        && unclosedReport.options.map(o => o.title).join(',') === '甲,乙,丙,丁,戊'
        && (unclosedReport.options[0]?.content ?? '').includes('旧渡口'),
        `path=${unclosedReport.path} count=${unclosedReport.options.length} dropped=${String(unclosedReport.dropped)}`,
    );

    // 句中被掐断：存活的是前 4 条（只断条数会让「丢错条」漏过）＋丢弃计数 1
    const midCutReport = parseOptions(PARTIAL_MID_CUT_RAW, 5);
    check(
        '元素级恢复：句中被掐断（第 5 条半个）→ partial 恢复前 4 条、丢弃 1',
        midCutReport.path === 'partial' && midCutReport.options.length === 4 && midCutReport.dropped === 1
        && midCutReport.options.map(o => o.title).join(',') === '甲,乙,丙,丁',
        `path=${midCutReport.path} count=${midCutReport.options.length} dropped=${String(midCutReport.dropped)}`,
    );

    // 完整 JSON 不受元素级恢复污染：同构夹具补齐收尾 → 仍走 json 主路径
    const completeReport = parseOptions(`${PARTIAL_UNCLOSED_RAW}\n]}`, 5);
    check(
        '元素级恢复：完整 JSON（同构夹具补齐收尾）→ json 主路径 5 条、无丢弃计数',
        completeReport.path === 'json' && completeReport.options.length === 5 && completeReport.dropped === undefined,
        `path=${completeReport.path} count=${completeReport.options.length}`,
    );

    // 纯散文零标题括号：不再合成整段散文当 1 条选项（fail fast 交上层报错带出原文）
    const proseReport = parseOptions('今天天气不错我们出去走走', 4);
    check(
        '散文零标题：不再合成整段散文当 1 条选项（非 bracket_fallback 且 0 条）',
        proseReport.path !== 'bracket_fallback' && proseReport.options.length === 0,
        `path=${proseReport.path} count=${proseReport.options.length}`,
    );

    // 正文含 "options":[ 字面量的讨论文本：不得把正文当选项数组恢复出垃圾
    const discussedReport = parseOptions('她聊起配置格式："options":[ 其实只是聊天正文', 4);
    check(
        '正文含 "options":[ 字面量不误锚（讨论文本按 JSON 骸骨拒收，0 条垃圾）',
        discussedReport.path === 'json_reject' && discussedReport.options.length === 0,
        `path=${discussedReport.path} count=${discussedReport.options.length}`,
    );

    // 锚点前先出现「非键形态的 "options" 词」而真契约在后：不得短路放弃
    // （候选不成立须继续后扫——短路会让本该恢复的选项连坐作废）。
    // 形态须以 { 开头才进对象契约分支：散文前缀走的是守门路径，测不到锚点。
    const lateAnchor = '{"note":"options","options":[{"title":"甲","content":"甲事"},{"title":"乙","content":"乙事"}';
    const lateReport = parseOptions(lateAnchor, 4);
    check(
        '锚点：前有非键 "options" 字符串值时继续后扫命中真契约（partial 恢复 2 条，不连坐作废）',
        lateReport.path === 'partial' && lateReport.options.length === 2,
        `path=${lateReport.path} count=${lateReport.options.length}`,
    );
}

/**
 * 请求形状终态机判：choice 请求由 TASK_DEFAULTS 常量注入（任务参数固化，
 * 用户面零旋钮）——reasoning_effort high＋temperature 1＋stream true＋
 * json_object response_format 四件套锁定。
 */
function runConstantRequestChecks(): void {
    const messages = [{ role: 'user' as const, content: 'x' }];
    const body = buildGenerateBody(messages, {
        task: 'choice',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        temperature: TASK_DEFAULTS.temperature,
        stream: TASK_DEFAULTS.stream,
        outputContract: TASK_DEFAULTS.choiceOutputContract,
        reasoningEffort: TASK_DEFAULTS.reasoningEffort,
    });
    const responseFormat = body.response_format as { type?: string } | undefined;
    check(
        'choice 请求形状终态＝常量注入（temperature 1/stream true/reasoning_effort high/response_format json_object）',
        body.temperature === 1 && body.stream === true && body.reasoning_effort === 'high'
        && responseFormat?.type === 'json_object'
        && !('max_tokens' in body) && !('json_schema' in body),
        `body=${JSON.stringify(body)}`,
    );
}

/**
 * debugForceRaw 调试开关机判（生成管线接线）。
 *
 * 置开关后走完整 generateOptions 管线（组装→跳过 API→直喂畸形样本→
 * 解析→store 会话态）：该分支构造上不 fetch（无网络依赖），断言产物
 * 走回退解析且会话态正确——开关不接生成管线的回归在此翻红。
 */
async function runDebugForceRawChecks(): Promise<void> {
    choiceStorage.updateGenParams({ debugForceRaw: true });
    try {
        await generateOptions();
        const store = useChoiceStore();
        check('debugForceRaw 走生成管线不报错（无 API 调用）', store.phase !== 'error' && store.options.length === 4, `phase=${store.phase} count=${store.options.length} error=${store.error}`);
        check('debugForceRaw 解析路径＝回退（bracket_fallback）', store.lastParsePath === 'bracket_fallback', `path=${store.lastParsePath}`);
        check('debugForceRaw dump 已更新（组装与发送同管线）', store.lastDump.includes('=== 消息组装 dump'), `dumpHead=${store.lastDump.slice(0, 40)}`);
    } finally {
        choiceStorage.updateGenParams({ debugForceRaw: false });
    }
}

/** 解析守门机判：JSON 骸骨三臂判据的拒收面＋取舍锁定。 */
function runParseGuardChecks(): void {
    // 现场实锤形态：值内未转义引号的坏 JSON——主路径 JSON.parse 失败，
    // 旧实现会落括号回退把整坨 JSON 合成一条废选项
    const badArrayJson = '[{"title":"A","content":"她说"你好"然后离开"}]';
    const badReport = parseOptions(badArrayJson, 4);
    check('解析防御：坏 JSON（数组形态＋值内未转义引号）不进括号回退——json_reject 路径 0 条（fail fast，不再合成废选项）',
        badReport.path === 'json_reject' && badReport.options.length === 0, `path=${badReport.path} count=${badReport.options.length}`);

    // 两臂各有样本：截断对象走「对象开头」臂；散文前缀＋键字面量走「契约键」臂
    const truncated = '{"options":[{"';
    const prosePrefix = '好的，以下是选项：\n{"options": [{"title":"A","content":"甲"';
    const truncatedReport = parseOptions(truncated, 4);
    const proseReport = parseOptions(prosePrefix, 4);
    check('解析防御：截断对象（{"options":[{" 早断）与散文前缀＋键字面量两臂各有样本拒收',
        truncatedReport.path === 'json_reject' && proseReport.path === 'json_reject'
        && truncatedReport.options.length === 0 && proseReport.options.length === 0,
        `path=${truncatedReport.path}/${proseReport.path}`);

    // 取舍锁定：合法括号形态但正文含键字面量的纯文本被拒收——fail fast
    // 可见，优于静默废选项（判据选择文档化的取舍，见 parse.ts 守门注释）
    const bracketWithLiteral = '[回忆片段] 这段正文里带 "title" 字面量';
    const literalReport = parseOptions(bracketWithLiteral, 4);
    check('守门取舍：括号正文含 "title" 字面量的纯文本按 JSON 骸骨拒收（fail fast 可见，优于静默废选项——取舍锁定）',
        literalReport.path === 'json_reject' && literalReport.options.length === 0, `path=${literalReport.path}`);

    // 坏 JSON 对象契约形态（真正走元素扫描器的路径）：两类形态都必须整批
    // 拒收——分隔符校验缺失时「他说}了」形态会被错位切成恰好合法的子串、
    // 静默恢复成 1 条垃圾选项报 partial（比报错更坏的回归），此处钉死归属
    const badUnclosedQuote = '{"options":[{"title":"A","content":"他说"}了"}]}';
    const badInlineQuote = '{"options":[{"title":"A","content":"她说"你好"然后离开"}]}';
    const badUnclosedReport = parseOptions(badUnclosedQuote, 4);
    const badInlineReport = parseOptions(badInlineQuote, 4);
    check(
        '解析防御：坏 JSON 对象契约形态（值内未转义引号两种变体）经元素扫描后仍整批拒收——json_reject 0 条，绝不静默恢复垃圾选项',
        badUnclosedReport.path === 'json_reject' && badUnclosedReport.options.length === 0
        && badInlineReport.path === 'json_reject' && badInlineReport.options.length === 0,
        `path=${badUnclosedReport.path}/${badInlineReport.path} count=${badUnclosedReport.options.length}/${badInlineReport.options.length}`,
    );

    // 守门样本族汇总回归：既有守门样本在新主路径（元素级恢复）下归属不变
    const guardFamily: Array<[string, string]> = [
        ['数组形态未转义引号', '[{"title":"A","content":"她说"你好"然后离开"}]'],
        ['截断对象', '{"options":[{"'],
        ['散文前缀＋键字面量', '好的，以下是选项：\n{"options": [{"title":"A","content":"甲"'],
        ['括号正文含键字面量', bracketWithLiteral],
    ];
    const familyReports = guardFamily.map(([name, sample]) => [name, parseOptions(sample, 4)] as const);
    check(
        '解析防御汇总：守门样本族（数组/截断/散文前缀/字面量）在新主路径下仍全数 json_reject 0 条',
        familyReports.every(([, r]) => r.path === 'json_reject' && r.options.length === 0),
        familyReports.map(([n, r]) => `${n}=${r.path}`).join('、'),
    );
}

/**
 * runlog 接线机判：生成管线的记录落点（成功/失败/环形上限/密钥金丝雀）。
 * stub fetch 形态仿 persona smoke（全局 fetch 替换＋finally 还原）。
 */
async function runRunlogChecks(): Promise<void> {
    const runlog = useRunlogStore();
    runlog.clear();

    // 成功面：debugForceRaw 走完整管线（无网络依赖），记录带解析结论
    choiceStorage.updateGenParams({ debugForceRaw: true });
    try {
        await generateOptions();
        const record = runlog.records[runlog.records.length - 1];
        check('runlog：debugForceRaw 生成成功落记录（ok=true、responseText 非空、parsePath/条数进记录）',
            !!record && record.ok && record.responseText === DEBUG_MALFORMED_RAW
            && record.parsePath === 'bracket_fallback' && record.optionCount === 4
            && record.endpointUrl === '(debugForceRaw)',
            `ok=${String(record?.ok)} parsePath=${record?.parsePath ?? '无'} count=${String(record?.optionCount)}`);
    } finally {
        choiceStorage.updateGenParams({ debugForceRaw: false });
    }

    // 失败面：端点缺失（请求未发出）由 generator 哨兵补记 ok:false
    const savedActiveEndpointId = readActiveEndpointId();
    setActiveEndpointId('no-such-endpoint');
    await generateOptions();
    const failRecord = runlog.records[runlog.records.length - 1];
    check('runlog：端点缺失失败落记录（ok=false、error 含「未选择生成端点」、requestText 在场）',
        !!failRecord && failRecord.ok === false && (failRecord.error ?? '').includes('未选择生成端点') && failRecord.requestText.length > 0,
        `ok=${String(failRecord?.ok)} error=${failRecord?.error ?? '无'}`);
    setActiveEndpointId(savedActiveEndpointId);
    // 端点缺失用例把会话态留在 error 相位——复位，免污染后续守卫链断言基准
    useChoiceStore().$reset();

    // 环形上限：连 commit 25 条只留末 20（最旧被裁剪）
    runlog.clear();
    for (let i = 0; i < 25; i++) {
        runlog.commit({
            at: new Date().toISOString(), task: 'choice', endpointUrl: '(test)', model: `m${i}`,
            contract: 'prompt_only', stream: false, durationMs: 0, ok: true, requestText: '', responseText: '',
        });
    }
    check('runlog：环形上限 20（连 commit 25 条只留末 20）',
        runlog.records.length === 20 && runlog.records[0]?.model === 'm5' && runlog.records[19]?.model === 'm24',
        `len=${runlog.records.length} first=${runlog.records[0]?.model} last=${runlog.records[19]?.model}`);

    // 密钥金丝雀：传输层记录全量序列化后不得含 apiKey（端点身份只存 url/model）
    runlog.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
        ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'canary-ok' } }] }),
    })) as unknown as typeof fetch;
    try {
        const result = await callGenerateEndpoint(
            [{ role: 'user', content: 'hi' }],
            { task: 'choice', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-leak-canary', model: 'm1', stream: false, outputContract: 'prompt_only' },
        );
        const allRecords = JSON.stringify(runlog.records);
        check('runlog：密钥金丝雀——stub fetch 走一次 callGenerateEndpoint（apiKey=\'sk-leak-canary\'，stub 形态仿 persona smoke），全记录序列化不含该值',
            result.runId > 0 && runlog.records.length === 1 && !allRecords.includes('sk-leak-canary'),
            `records=${runlog.records.length} leak=${String(allRecords.includes('sk-leak-canary'))}`);
    } finally {
        globalThis.fetch = originalFetch;
    }

    // partial 遥测端到端：stub fetch 回缺收口 JSON（流式帧形态）→ 生成管线
    // 走元素级恢复，runlog enrich 带解析路径与丢弃计数（排障可见性）
    {
        const savedEndpoints = readApiDomain();
        const savedActiveEndpointId = readActiveEndpointId();
        const partialEndpoint = savedEndpoints[0] ?? createEndpoint('partial 端点');
        if (savedEndpoints.length === 0) writeApiDomain([partialEndpoint]);
        setActiveEndpointId(partialEndpoint.id);
        const originalFetch = globalThis.fetch;
        const partialEncoder = new TextEncoder();
        globalThis.fetch = (async () => ({
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: PARTIAL_MID_CUT_RAW } }] }),
            body: {
                getReader: () => {
                    const frames = [
                        partialEncoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: PARTIAL_MID_CUT_RAW } }] })}\n\n`),
                        partialEncoder.encode('data: [DONE]\n\n'),
                    ];
                    return { read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true } };
                },
            },
        })) as unknown as typeof fetch;
        try {
            runlog.clear();
            await generateOptions();
            const record = runlog.records[runlog.records.length - 1];
            const store = useChoiceStore();
            check(
                'runlog：partial 生成 enrich 带解析路径与丢弃计数（4 条恢复＋1 条丢弃）',
                !!record && record.ok && record.parsePath === 'partial' && record.optionCount === 4 && record.dropped === 1
                && store.options.length === 4 && store.lastParsePath === 'partial',
                `ok=${String(record?.ok)} path=${record?.parsePath ?? '无'} count=${String(record?.optionCount)} dropped=${String(record?.dropped)}`,
            );
        } finally {
            globalThis.fetch = originalFetch;
            setActiveEndpointId(savedActiveEndpointId);
            if (savedEndpoints.length === 0) writeApiDomain([]);
            useChoiceStore().$reset();
        }
    }
}

/** 冒烟入口（main.ts node 分支调用；返回失败清单长度供收口）。 */
export async function runChoiceSmoke(): Promise<void> {
    console.info('=== choice 组装/解析机判 ===');
    const dumpText = runAssemblyChecks();
    console.info('=== 组装 dump 全文 ===');
    console.info(dumpText);
    runParseChecks();
    runParseGuardChecks();
    runConstantRequestChecks();
    await runDebugForceRawChecks();
    await runRunlogChecks();
    console.info('=== choice 池抽取/asset 同步/注入/自动生成机判 ===');
    runPoolChecks();
    runAssetPoolChecks();
    runInjectionChecks();
    await runAutoGenerateChecks();
    await runFloorPersistChecks();
    if (failures.length > 0) {
        console.error(`[choice-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[choice-smoke] OK：组装注入逐项可见、占位符替换、trace 覆盖、解析回退确定性触发、debugForceRaw 生成管线接线全部通过；池抽取分布/数学、asset 同步（110 条/17 分类/首次翻转/幂等不回翻/污染恢复）、池注入分区、MESSAGE_RECEIVED 守卫链全部通过；楼层落盘（roundtrip/saveChat 通道/刷新恢复/切聊天/重 roll 作废/swipe 跟随/删楼重载/写侧守门/坏档回退）全部通过。');
}
