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
import { TASK_PARAMS } from '@/modules/apis/task-defaults';
import { missingTaskModelError, mutateTaskProfiles, readTaskProfiles, resolveTaskRoute, writeTaskProfiles, type TaskProfilesDomain } from '@/modules/apis/task-profiles';
import { useRunlogStore } from '@/modules/runlog/store';
import { createEndpoint, readApiDomain, writeApiDomain } from '@/modules/apis/storage';
import { DEBUG_MALFORMED_RAW, parseOptions } from './parse';
import { choiceStorage, GLOBAL_CHOICE_KEY, type ChoiceDomain, type ChoiceGenParams } from './api';
import { DEFAULT_POOL_GEN_PARAMS } from './pool/normalize';
import { applyOption, cancelGeneration, generateOptions, zeroOptionsMessage } from './generator';
import { readFloorOptions, writeFloorOptions } from './persist';
import { useChoiceStore } from './store';
import { useChoiceSettingsStore } from './settings';
import { drawAmount, resolvePool } from './pool/resolver';
import type { DrawResult, PoolEntry } from './pool/types';
import { ASSET_POOL_VERSION, buildAssetPool, syncAssetPool } from './pool/asset';
import { getGlobal, setGlobal } from '@/storage';

/**
 * 组装产物里允许出现的分段标签白名单（注入源与文本段各自的标签）。
 * 标签是每个段在提示词里唯一的可机判身份：白名单锁住「新增或移除注入段
 * 时这里必须同步登记」这条契约，退役的段没被移除时无需在断言里点名它。
 */
const ASSEMBLY_SEGMENT_TAGS: readonly string[] = [
    'persona', 'character', 'personality', 'scenario', 'world_info',
    'direction', 'external_memory', 'pool_entries', 'current_scene',
    'rules', 'example', 'format',
];

/**
 * 注入段的判定形态：独占一行的 <tag>。段在场/缺席一律按段判，不按子串
 * 判——模板正文合法内联提到标签名（慢热闸规则拿它指代别的插件写入的
 * 记忆），子串判据会把「规则提到」误判成「段在场」。
 */
const SEGMENT_LINE_PATTERN = /^<([a-z_]+)>$/gm;

/** 取出文本里独占一行的注入段标签（按出现顺序，未去重）。 */
function segmentTagsIn(text: string): string[] {
    return [...text.matchAll(SEGMENT_LINE_PATTERN)].map(m => m[1]);
}

const failures: string[] = [];

/** choice 行档案单行写（夹具用；其余行不动）。 */
function setChoiceProfile(providerId: string, model: string): void {
    mutateTaskProfiles(profiles => {
        profiles.choice = { providerId, model };
    });
}

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

function makeEntry(id: string, pinned: boolean, category = '默认'): PoolEntry {
    return { id, type: `选项${id}`, content: `${id}的行动正文`, category, pinned };
}

/** 1) 抽取分布与数学（种子 PRNG 驱动 resolvePool 纯函数）。 */
function runPoolChecks(): void {
    // 等权分布：8 条同权条目，每轮抽 4。每条命中频次应大致均摊
    // （每轮换种子——300 轮聚合抹平单轮波动；期望 150/条，100-200 为安全带）
    const distPool = Array.from({ length: 8 }, (_, i) => makeEntry(`e${i}`, false));
    const ROUNDS = 300;
    const hits = new Array<number>(8).fill(0);
    for (let i = 0; i < ROUNDS; i++) {
        const result = resolvePool({ pool: distPool, count: 4, categoriesEnabled: false, pinnedOverflow: 'send_all', oversamplePct: 0, shuffleFinal: true, random: mulberry32(0xc0ffee + i) });
        result.drawn.forEach(e => {
            hits[Number(e.id.slice(1))]++;
        });
    }
    check('抽取分布：等权条目命中频次大致均摊（300 轮）', hits.every(h => h >= 100 && h <= 200), `hits=${hits.join('/')}`);

    // pinned 恒在：send_all 策略下每轮必含全部 pinned
    const pinnedPool = [makeEntry('p1', true), makeEntry('p2', true), makeEntry('c1', false), makeEntry('c2', false)];
    let pinnedOk = true;
    for (let i = 0; i < 100; i++) {
        const result = resolvePool({ pool: pinnedPool, count: 4, categoriesEnabled: false, pinnedOverflow: 'send_all', oversamplePct: 0, shuffleFinal: true, random: mulberry32(0x1234 + i) });
        if (!result.pinned.some(e => e.id === 'p1') || !result.pinned.some(e => e.id === 'p2')) pinnedOk = false;
    }
    check('抽取分布：pinned 恒在结果（send_all 全发）', pinnedOk);

    // trim：pinned 超过 count 时打乱后截到 count
    const overPool = Array.from({ length: 5 }, (_, i) => makeEntry(`p${i}`, true));
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
        makeEntry('a1', false, '甲'), makeEntry('a2', false, '甲'),
        makeEntry('b1', false, '乙'), makeEntry('b2', false, '乙'),
        makeEntry('c1', false, '丙'), makeEntry('c2', false, '丙'),
    ];
    let catOk = true;
    for (let i = 0; i < 10; i++) {
        const result = resolvePool({ pool: catPool, count: 6, categoriesEnabled: true, pinnedOverflow: 'send_all', oversamplePct: 0, shuffleFinal: true, random: mulberry32(0x9abc + i) });
        const buckets = new Set(result.drawn.map(e => e.category));
        if (buckets.size < 2) catOk = false;
    }
    check('分组轮询：候选覆盖多个 category 桶（≥2 桶）', catOk);
}

/**
 * 1.6) 池旋钮贯通（UI 写面 → normalize → resolver）：置顶超额策略与末段打乱
 * 在设置页接上写面之前恒为 normalize 默认值——两个参数从未被真实用户数据走
 * 过。本区把「store 写 → 域读回（钳制后）→ resolver 入参」串成一条链：写面
 * 漏传、钳制语义漂、resolver 分支与旋钮值脱钩，三处断链任一都在这里红。
 */
function runPoolKnobChecks(): void {
    const settings = useChoiceSettingsStore();
    const saved = getGlobal(GLOBAL_CHOICE_KEY);
    // 池规模随域内 count 现值走：置顶条目取 count+2 条恒构成超额（trim 面
    // 可观测），候选区留 4 条保证任何倍率下都抽得到、不落空态
    const { count } = choiceStorage.readDomain().gen;
    const knobPool = [
        ...Array.from({ length: count + 2 }, (_, i) => makeEntry(`kp${i}`, true)),
        ...Array.from({ length: 4 }, (_, i) => makeEntry(`kc${i}`, false)),
    ];
    const inputOrder = knobPool.filter(e => e.pinned).map(e => e.id).join(',');
    // resolver 入参与 pool/storage.ts 的生成管线同形（逐项取自读面）：设置页
    // 写面新增字段若漏进生成管线，这里解析出的结果就与真实生成不是一回事
    const resolveFromDomain = (seed: number): DrawResult => {
        const { gen } = choiceStorage.readDomain();
        return resolvePool({
            pool: knobPool,
            count: gen.count,
            categoriesEnabled: gen.categoriesEnabled,
            pinnedOverflow: gen.pinnedOverflow,
            oversamplePct: gen.oversamplePct,
            shuffleFinal: gen.shuffleFinal,
            random: mulberry32(seed),
        });
    };
    const orderOf = (result: DrawResult, zone: 'pinned' | 'drawn'): string => result[zone].map(e => e.id).join(',');
    const contentOf = (result: DrawResult, zone: 'pinned' | 'drawn'): string => [...result[zone].map(e => e.id)].sort().join(',');
    // 顺序断言取多组固定种子：单组可能偶然同序/偶然全异，多组两面各判一次
    const ORDER_SEEDS = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888];
    try {
        // 并排组：同一种子先关后开各抽一轮——末段打乱是纯顺序操作，抽到哪些
        // 条目不该随开关变（变即是抽取逻辑被开关污染）
        const pairs = ORDER_SEEDS.map((seed) => {
            settings.updateGen({ shuffleFinal: false });
            const off = resolveFromDomain(seed);
            settings.updateGen({ shuffleFinal: true });
            return { off, on: resolveFromDomain(seed) };
        });
        settings.updateGen({ pinnedOverflow: 'trim', shuffleFinal: false });
        const written = choiceStorage.readDomain().gen;
        check(
            '池旋钮写面：UI 写 trim/不打乱后域读回同值（落档链路贯通）',
            written.pinnedOverflow === 'trim' && written.shuffleFinal === false,
            `overflow=${written.pinnedOverflow} shuffle=${String(written.shuffleFinal)}`,
        );

        const trimmed = resolveFromDomain(0x1a2b);
        settings.updateGen({ pinnedOverflow: 'send_all' });
        const sendAll = resolveFromDomain(0x1a2b);
        check(
            '池旋钮贯通：置顶超额时 trim 截到条数、send_all 全保留（resolver 随旋钮变）',
            trimmed.pinned.length === count && sendAll.pinned.length === count + 2,
            `trim=${trimmed.pinned.length} send_all=${sendAll.pinned.length} count=${count}`,
        );

        const keptOff = pairs.filter(p => orderOf(p.off, 'pinned') === inputOrder).length;
        const keptOn = pairs.filter(p => orderOf(p.on, 'pinned') === inputOrder).length;
        check(
            '池旋钮贯通：末段打乱关闭时置顶区保持输入序、打开后被打乱（8 组种子）',
            keptOff === ORDER_SEEDS.length && keptOn === 0,
            `关=${keptOff}/${ORDER_SEEDS.length} 开=${keptOn}/${ORDER_SEEDS.length}`,
        );

        check(
            '池旋钮贯通：末段打乱只改出场序不改内容（同种子开/关两区条目集合逐条一致）',
            pairs.every(p => contentOf(p.off, 'pinned') === contentOf(p.on, 'pinned') && contentOf(p.off, 'drawn') === contentOf(p.on, 'drawn')),
            `置顶样例=${orderOf(pairs[0].off, 'pinned')} → ${orderOf(pairs[0].on, 'pinned')}`,
        );

        // 坏值钳制：写面若送出枚举外/非布尔值，域读回必须是默认（旋钮缺省与
        // normalize 单一真相，UI 不另立缺省）
        settings.updateGen({ pinnedOverflow: 'trim_ex', shuffleFinal: 'yes' } as unknown as Partial<ChoiceGenParams>);
        const clamped = choiceStorage.readDomain().gen;
        check(
            '池旋钮写面：非法枚举/非布尔经 normalize 钳回默认（send_all/true）',
            clamped.pinnedOverflow === DEFAULT_POOL_GEN_PARAMS.pinnedOverflow && clamped.shuffleFinal === DEFAULT_POOL_GEN_PARAMS.shuffleFinal,
            `overflow=${clamped.pinnedOverflow} shuffle=${String(clamped.shuffleFinal)}`,
        );
    } finally {
        // 还原存回原值（不存 readDomain 的归一投影：那会把夹具没写过的默认
        // 字段补进存储，与「本区不留残」的纪律相悖）
        setGlobal(GLOBAL_CHOICE_KEY, saved);
    }
}

/**
 * 1.5) 池 asset（只读资产）：内置池静态形状＋syncAssetPool 行为机判。
 */
function runAssetPoolChecks(): void {
    // ---- 静态形状（纯函数，不依赖存储态）----
    const { masterPool } = buildAssetPool();
    check('asset：内置池 130 条（纯走法制版）', masterPool.length === 130, `实际 ${masterPool.length}`);
    const cats = new Set(masterPool.map(e => e.category));
    check(
        'asset：9 个分类（纯走法制版）',
        cats.size === 9 && ['接住对方', '关系走法', '言语走法', '身体行动', '局面推进', '外部变化', '节奏调度', '视角形式', 'NSFW'].every(c => cats.has(c)),
        `实际 ${[...cats].join('/')}`,
    );
    const transition = masterPool.find(e => e.type === '转场推进');
    // pinned 恰 1 是注入公式（1 置顶＋(count−1)＋…）与设置页估算行的共同前提，多一条即静默分家。
    check('asset：转场推进转固定（pinned 且全池唯一）', !!transition && transition.pinned && masterPool.filter(e => e.pinned).length === 1, `pinned=${String(transition?.pinned)} 共 ${masterPool.filter(e => e.pinned).length}`);
    const types = new Set(masterPool.map(e => e.type));
    check('asset：条目 type 唯一（走法名即身份，id 是下标生成的派生值）', types.size === masterPool.length && masterPool[0].id === 'asset-1', `唯一 ${types.size}/${masterPool.length} 首条 ${masterPool[0]?.id}`);
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
    check('asset 首次同步：空池覆盖为 130 条并标记 assetVersion', domain.pool.masterPool.length === 130 && domain.pool.assetVersion === ASSET_POOL_VERSION, `条目 ${domain.pool.masterPool.length} v=${String(domain.pool.assetVersion)}`);
    check('asset 首次同步：categoriesEnabled 旧 false 翻转为 true', domain.gen.categoriesEnabled === true, `categoriesEnabled=${String(domain.gen.categoriesEnabled)}`);
    // 用户手动关：后续同步不得回翻（gen 纯用户域）
    choiceStorage.updateGenParams({ categoriesEnabled: false });
    syncAssetPool();
    domain = choiceStorage.readDomain();
    check('asset 幂等同步：用户关掉的轮询不被回翻', domain.gen.categoriesEnabled === false, `categoriesEnabled=${String(domain.gen.categoriesEnabled)}`);
    // 内容污染＋版本变更（assetVersion 指向旧版本）→ 同步全量恢复、不动 gen
    choiceStorage.writeDomain(d => {
        d.pool.masterPool.push({ id: 'smoke-junk', type: '垃圾', content: '应被覆盖', category: 'x', pinned: false });
        d.pool.assetVersion = 0;
    });
    syncAssetPool();
    domain = choiceStorage.readDomain();
    check(
        'asset 版本变更：污染池全量恢复（垃圾清除、gen 不动）',
        domain.pool.masterPool.length === 130 && !domain.pool.masterPool.some(e => e.id === 'smoke-junk') && domain.pool.assetVersion === ASSET_POOL_VERSION && domain.gen.categoriesEnabled === false,
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
        !allText.includes('<pool_rules>') && allText.includes('<rules>') && allText.includes('从这个角色本来会的方式里来'),
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

/** 发送面捕获桩（scripts/smoke.mjs 注入；装卸与 DOM 形态理由见该文件）。 */
interface SendSurfaceStub {
    /** 每次输入框写入的完整文本（三个点击行为都经这里落地） */
    writes: string[];
    /** 每次宿主发送调用瞬间的输入框文本快照 */
    sends: string[];
    /** 预置输入框旧值（追加行为的拼接前缀） */
    seed(text: string): void;
    /** 断言窗口内装上最小 DOM（node 冒烟全程无 DOM） */
    install(): void;
    uninstall(): void;
}

/** 冒烟 stub 访问（scripts/smoke.mjs 注入；类型只声明本文件用到的面）。 */
interface SmokeStubs {
    eventSource: { emit(type: string, ...args: unknown[]): unknown };
    getContext(): { chat: unknown[] };
    saveChatCalls: number;
    sendSurface: SendSurfaceStub;
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
    // 服务商与 choice 行档案在场（stub fetch 在 smoke.mjs 注入）——
    // 记录原态，收尾统一还原
    const savedEndpoints = readApiDomain();
    const savedProfilesJson = JSON.stringify(readTaskProfiles());
    const smokeEndpoint = savedEndpoints[0] ?? createEndpoint('冒烟端点');
    if (savedEndpoints.length === 0) {
        writeApiDomain([smokeEndpoint]);
    }
    setChoiceProfile(smokeEndpoint.id, smokeEndpoint.models[0] ?? 'smoke-model');
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

    // 任务模型未配置：choice 行悬空 → resolveTaskRoute null → console.warn（不弹 UI）
    setChoiceProfile('no-such-endpoint', 'x');
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warns.push(args.map(String).join(' '));
    };
    emitReceived(2, 'normal');
    console.warn = origWarn;
    check('自动生成：任务模型未配置 console.warn 跳过（不弹 UI）', store.phase === 'idle' && warns.some(w => w.includes('自动生成跳过') && w.includes('未配置选项生成模型')), `warns=${warns.length}`);
    setChoiceProfile(smokeEndpoint.id, smokeEndpoint.models[0] ?? 'smoke-model');

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

    // 还原档案与服务商表原态（前置前记录的快照；本区自落的冒烟端点与
    // 配置态不留残）
    writeTaskProfiles(JSON.parse(savedProfilesJson) as TaskProfilesDomain);
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
    const savedProfilesJson = JSON.stringify(readTaskProfiles());

    // 索引签名对齐 ChatMessage（宿主消息含任意附加键，extra/swipes 等）
    interface FakeMessage { mes?: string; is_user?: boolean; is_system?: boolean; extra?: Record<string, unknown>; [key: string]: unknown; }
    const msg = (mes: string, extra?: Record<string, unknown>): FakeMessage => ({ mes, is_user: false, extra });
    const choiceExtra = (options: Array<{ title: string; content: string }>, parsePath = 'json'): Record<string, unknown> => ({
        ttToolkit: { choice: { options, parsePath } },
    });

    // ① 楼层级 roundtrip（机制底座）＋② 落盘通道确实被调用
    const chat1: FakeMessage[] = [msg('（角色卡开场白楼层）'), msg('AI 的真实回复正文。')];
    context.chat = chat1;
    const optsA = [{ title: '甲', content: '做甲事' }];
    const callsBefore = stubs.saveChatCalls;
    check('楼层落盘：writeFloorOptions 写入并返回 true', writeFloorOptions({ index: 1, payload: { options: optsA, parsePath: 'json' }, expectMessage: null }) === true);
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
    writeFloorOptions({ index: 1, payload: { options: [{ title: '乙', content: '做乙事' }], parsePath: 'bracket_fallback' }, expectMessage: null });
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
    // 失败路径：请求未发出（任务模型未配置）——生成开始已清档，该楼保持无选项态
    writeFloorOptions({ index: 1, payload: { options: optsA, parsePath: 'json' }, expectMessage: null });
    setChoiceProfile('', '');
    try {
        await generateOptions();
    } finally {
        writeTaskProfiles(JSON.parse(savedProfilesJson) as TaskProfilesDomain);
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
    check('楼层落盘：写越界楼层返回 false 且不抛', writeFloorOptions({ index: 99, payload: { options: optsA, parsePath: 'json' }, expectMessage: null }) === false && writeFloorOptions({ index: -1, payload: { options: optsA, parsePath: 'json' }, expectMessage: null }) === false);
    const foreign = msg('别的消息对象');
    const mismatchCalls = stubs.saveChatCalls;
    check(
        '楼层落盘：写前对象校验（索引处已换成别的消息对象）拒绝写入且不触发落盘',
        writeFloorOptions({ index: 0, payload: { options: optsA, parsePath: 'json' }, expectMessage: foreign }) === false && readFloorOptions(0) === null && stubs.saveChatCalls === mismatchCalls,
        `calls=${stubs.saveChatCalls}`,
    );
    // expectMessage: null ＝显式声明「无凭据故不校验」——与旧的可选参数缺席
    // 同义，但改必填后由类型门拦住漏传（漏传即静默失去防漂移保护）。
    // 注意此刻 chat 仅剩 0 号开场白楼（上文 splice 后），故索引用 0。
    const nullGuardCalls = stubs.saveChatCalls;
    check(
        '楼层落盘：expectMessage=null 显式不校验仍正常写入（类型门拦漏传，语义与旧省略一致）',
        writeFloorOptions({ index: 0, payload: { options: optsA, parsePath: 'json' }, expectMessage: null }) === true && stubs.saveChatCalls === nullGuardCalls + 1,
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
    const partialWritten = writeFloorOptions({ index: 1, payload: { options: optsA, parsePath: 'partial', dropped: 2 }, expectMessage: null });
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
    check(
        '楼层落盘：旧档无 aim 读回后该键仍缺席（读侧容忍，不补默认值）',
        legacyBack !== null && legacyBack.options.length === 1 && !('aim' in legacyBack.options[0]),
        `keys=${Object.keys(legacyBack?.options[0] ?? {}).join('|')}`,
    );

    // aim 往返：存档是考古线索——回看楼层要能看到当时这条想撬动什么
    context.chat = [msg('（开场白）'), msg('aim 楼')];
    const aimOption = { title: '甲', content: '做甲事', aim: '撬一格关系' };
    const aimWritten = writeFloorOptions({ index: 1, payload: { options: [aimOption], parsePath: 'json' }, expectMessage: null });
    const aimBack = readFloorOptions(1);
    check(
        '楼层落盘：aim 随选项往返写入读回（写侧不静默丢字段）',
        aimWritten === true && aimBack?.options[0]?.aim === '撬一格关系',
        `written=${String(aimWritten)} read=${JSON.stringify(aimBack?.options[0] ?? null)}`,
    );
    context.chat = [msg('坏档楼', { ttToolkit: { choice: { options: [{ title: '甲', content: '做甲事', aim: { 想: 1 } }], parsePath: 'json' } } })];
    check('楼层落盘：坏档（aim 在场非字符串）回退 null', readFloorOptions(0) === null);
}

/**
 * 点击应用面机判（契约红线：aim 不随发言外发）——三个点击行为
 * fill/append/send 各自落到宿主发送通道的文本都必须只有正文。aim 属显示
 * 与存档面；它一旦混进发送内容，主模型会拿到一句写给玩家看的元信息。
 * 断言窗口内由 scripts/smoke.mjs 的发送面桩提供 #send_textarea（node
 * 冒烟全程无 DOM，装卸理由见该桩）。
 */
async function runApplyOptionChecks(): Promise<void> {
    const stubs = smokeStubs();
    if (!stubs) {
        check('applyOption 发送内容不含 aim', false, '__TT_SMOKE_STUBS__ 缺席（应在浏览器宿主外由 smoke.mjs 注入）');
        return;
    }
    const option = { title: '摊牌', content: '林霜把录音笔推到桌子中央：「那就别再绕了。」', aim: '逼对方当场表态' };
    const draft = '林霜已经笑了一下：';
    const last = (texts: string[]): string => texts[texts.length - 1] ?? '';
    const surface = stubs.sendSurface;
    const savedBehavior = choiceStorage.readDomain().gen.clickBehavior;
    let filled = '';
    let appended = '';
    let sent = '';
    surface.install();
    try {
        choiceStorage.updateGenParams({ clickBehavior: 'fill' });
        applyOption(option.content);
        filled = last(surface.writes);

        choiceStorage.updateGenParams({ clickBehavior: 'append' });
        surface.seed(draft);
        applyOption(option.content);
        appended = last(surface.writes);

        choiceStorage.updateGenParams({ clickBehavior: 'send' });
        applyOption(option.content);
        // 发送分支填完输入框才 fire-and-forget 发出去，等一个回合收口
        await new Promise(resolve => setTimeout(resolve, 0));
        sent = last(surface.sends);

        check(
            'applyOption 发送内容不含 aim',
            filled === option.content
                && appended === draft + option.content
                && sent === option.content
                && ![filled, appended, sent].some(text => text.includes(option.aim)),
            `fill=${filled} append=${appended} send=${sent}`,
        );
    } finally {
        choiceStorage.updateGenParams({ clickBehavior: savedBehavior });
        surface.uninstall();
    }
}

/** 组装纯函数路径机判（默认模板集＋合成源）。 */
function runAssemblyChecks(): string {
    const config = createDefaultPromptConfig();
    check('默认模板版本＝21（漏 bump 时本门红：存量默认快照不会被重建）', config.defaultsVersion === 21, `v=${String(config.defaultsVersion)}`);
    const sources = syntheticSources();
    const result = assembleMessages(config.modules, sources);

    const allText = result.messages.map(m => m.content).join('\n');
    const allSegments = segmentTagsIn(allText);

    // dump 断言核心：各注入逐项可见（段在场按独占一行的标签判，见
    // SEGMENT_LINE_PATTERN 的 why：子串判会被模板正文里的合法引用骗过）
    check('人设注入可见（<persona> 段含 persona 正文）', allSegments.includes('persona') && allText.includes('王玉，28 岁'));
    check('角色卡描述注入可见（<character> 段）', allSegments.includes('character') && allText.includes('林霜，表面温婉'));
    check('角色卡性格注入可见（<personality> 段）', allSegments.includes('personality') && allText.includes('表面温和，回避直接冲突'));
    check('角色卡场景注入可见（<scenario> 段）', allSegments.includes('scenario') && allText.includes('现代都市职场'));
    check('世界书前插注入可见（<world_info> 段）', allSegments.includes('world_info') && allText.includes('一栋老写字楼'));
    check('世界书深度桶（深组）注入可见', allText.includes('【三年前】'));
    check('聊天历史注入（末条 AI 楼层 <current_scene> 包裹）', allSegments.includes('current_scene') && allText.includes('她垂下眼帘'));
    check('story_direction 注入可见（<direction> 段＝预设正文＋自由文本拼接）', allSegments.includes('direction') && allText.includes('未解之谜') && allText.includes('重点描写她的回避态度'));
    // 走向形态：自由文本为主＋预设拼接；两者皆空＝模块按未启用处理
    const emptyDirection = assembleMessages(config.modules, { ...sources, storyDirection: { presetText: '', freeText: '' } });
    const emptyDirTrace = emptyDirection.trace.find(t => t.moduleId === 'inject_story_direction');
    check('story_direction 两者皆空＝不注入（trace 留痕）', emptyDirTrace?.injected === false && emptyDirTrace.note.includes('未设置'), `note=${emptyDirTrace?.note ?? '（无 trace）'}`);
    const freeOnlyDirection = assembleMessages(config.modules, { ...sources, storyDirection: { presetText: '', freeText: '重点描写她的回避态度' } });
    const freeOnlyText = freeOnlyDirection.messages.map(m => m.content).join('\n');
    check('story_direction 仅自由文本也注入（无预设可用）', segmentTagsIn(freeOnlyText).includes('direction') && freeOnlyText.includes('重点描写她的回避态度') && !freeOnlyText.includes('未解之谜'));
    // 外部槽位：合成源给了非空槽位内容 → 注入可见（非空即带单步链路）。
    // 逐槽位标注：内容段带槽位 key 前缀、trace note 同粒度（逐项可见到槽位）
    check('外部注入槽位搬入可见（<external_memory> 段逐槽位标注）', allSegments.includes('external_memory') && allText.includes('[槽位 1_memory]') && allText.includes('两人在酒馆发生过争执'));
    const injectedExtTrace = result.trace.find(t => t.moduleId === 'inject_external_slot');
    check('外部槽位 trace 注记到槽位粒度', injectedExtTrace?.injected === true && injectedExtTrace.note.includes('1_memory'), `note=${injectedExtTrace?.note ?? '（无 trace）'}`);
    // 自动口径的另一侧：无槽位供给（没有插件写入公共注入区）→ 段缺席
    // 不报错、trace 留痕（兼容不了就什么都不带——最近几轮聊天记录兜底）
    const noSlot = assembleMessages(config.modules, { ...sources, externalSlots: [] });
    const noSlotTrace = noSlot.trace.find(t => t.moduleId === 'inject_external_slot');
    const noSlotText = noSlot.messages.map(m => m.content).join('\n');
    // 判「段缺席」按段判不按子串：慢热闸规则正文里合法引用了这个标签名
    // （指代别的插件写入的记忆），子串判据会把「规则提到它」误判成
    // 「段在场」。
    check('外部槽位无供给＝段缺席不报错（trace 留痕）', !segmentTagsIn(noSlotText).includes('external_memory') && noSlotTrace?.injected === false && noSlotTrace.note.includes('无可用槽位'), `note=${noSlotTrace?.note ?? '（无 trace）'}`);
    // 分段标签白名单：组装产物里独占一行的 <tag> 必须都在此登记。锁的是
    // 「每个注入段都在模板里显式登记过」这条契约——退役的注入段与任何
    // 未登记的新段都在这里翻红（断言走白名单而不是点名某个段标签：提交
    // 前的符号归零 grep 把被退役的字面量判为残留）。
    const assemblyTags = [...new Set(allSegments)];
    check(
        '分段标签白名单：组装产物的注入段全部已登记（退役段/未登记新段在此翻红）',
        assemblyTags.every(tag => ASSEMBLY_SEGMENT_TAGS.includes(tag)),
        `标签=${assemblyTags.join(',')}`,
    );
    // 模板正文引用的段标签（如慢热闸提 <external_memory>、任务指令提
    // <persona>/<current_scene>）必须指向已登记段：标签名由 engine 的
    // wrapTag 拥有、模板文本手写引用，两处无编译期关联——engine 改标签
    // 名时这条把规则里的静默悬空引用拦下来
    const templateTagRefs = [...new Set(config.modules
        .flatMap(m => (m.kind === 'text' ? [...m.content.matchAll(/<([a-z_]+)>/g)].map(x => x[1]) : [])))];
    check(
        '模板段标签引用全部指向已登记段（规则里的标签引用不悬空）',
        templateTagRefs.every(t => ASSEMBLY_SEGMENT_TAGS.includes(t)),
        `引用=${templateTagRefs.join(',')}`,
    );
    check('占位符替换（{{user}}/{{char}}/{{count}}）', !allText.includes('{{user}}') && !allText.includes('{{char}}') && !allText.includes('{{count}}') && allText.includes('王玉') && allText.includes('林霜'));
    // G2 视角口径：规则/few-shot/指令三层全部第三人称混合视角
    check('写作规则含三种推进视角（用户行动/角色主动/场景事件）', allText.includes('场景层面的事件') && allText.includes('主动行为'));
    // 戏剧观两层同锁：规则第 3 条（约束层）＋ few_shot 写法对照段（示范层）
    check('写作规则锁「见分晓拍」（正在发生、即将见分晓）', allText.includes('即将见分晓') && allText.includes('不写做完了的事后汇报'), `见分晓=${allText.includes('即将见分晓')}`);
    check('few_shot 写法对照段在场（不要事后汇报／要见分晓）', allText.includes('写法对照') && allText.includes('不要（事后汇报）') && allText.includes('要（见分晓）'));
    // 慢热闸：模板里唯一的推进闸（规则第 9 条），改成别的口径即翻红
    check('写作规则含慢热闸（与记忆现状相称、一次只推一小格）', allText.includes('慢热闸') && allText.includes('一次只推一小格'), `慢热闸=${allText.includes('慢热闸')}`);
    // 平行分支口径：同一刻的多种走法，彼此不互为前情（防递进式串联）。
    // 三层同锁：平行分支规则（禁令）＋few-shot 引导句（示范层）＋任务指令（收尾层）
    // ——只锁一层时另两层被改回串联形态不会翻红
    check('写作规则＝同一刻的平行分支（各走一路、不互为前情）',
        allText.includes('此刻同时摆开') && allText.includes('不互为因果') && allText.includes('不得被当成另一条的前情'),
        `平行口径=${allText.includes('此刻同时摆开')}`);
    // galgame 选项铁律：同一拍覆盖不同性格倾向的玩家——每条面向一种玩家心态
    check('选项面向不同玩家心态（同一拍覆盖不同性格倾向）',
        allText.includes('面向一种玩家心态') && allText.includes('不同心情的玩家都有顺手的一条'),
        `心态覆盖=${allText.includes('面向一种玩家心态')}`);
    check('平行口径三层同锁（规则/示例/指令）且旧措辞清零',
        allText.includes('各走一路') && allText.includes('并排的') && !allText.includes('角度错开'),
        `示例层=${allText.includes('各走一路')} 指令层=${allText.includes('并排的')}`);
    check('第三人称硬约束在场（用角色名或他／她）', allText.includes('第三人称') && allText.includes('不用「你」'));
    check('旧用户视角措辞清零', !allText.includes('以用户视角写') && !allText.includes('只写'));
    check('few-shot 旧三条仍在（反客为主/骤然断电）', allText.includes('反客为主') && allText.includes('骤然断电'));
    // few-shot 7 条（真人反应类型覆盖）
    const fewShot = config.modules.find(m => m.id === 'few_shot');
    const fewShotCount = fewShot && fewShot.kind === 'text' ? (fewShot.content.match(/"title":/g) ?? []).length : 0;
    check('few-shot 输出示例为 4 条（与恰好 N 条同基数；写法对照段另计）', fewShotCount === 4, `条数=${fewShotCount}`);
    // aim 的模板两面：示例四条各带（示例即格式范本，漏一条即教会模型漏
    // 一条），契约声明键名而规则段不提它（元信息不占每轮规则预算）
    const fewShotAimCount = fewShot && fewShot.kind === 'text' ? (fewShot.content.match(/"aim":/g) ?? []).length : 0;
    check('few-shot 输出示例四条各带 aim（示例即格式范本）', fewShotAimCount === fewShotCount && fewShotCount > 0, `aim=${fewShotAimCount} 条=${fewShotCount}`);
    const outputFormat = config.modules.find(m => m.id === 'output_format');
    const coreRules = config.modules.find(m => m.id === 'core_rules');
    check(
        '输出契约声明 aim 键且写作规则段不提 aim（元信息只进显示与存档，不占规则段预算）',
        outputFormat?.kind === 'text' && outputFormat.content.includes('"aim":')
            && coreRules?.kind === 'text' && !coreRules.content.includes('aim'),
        `format=${outputFormat?.kind === 'text' ? String(outputFormat.content.includes('"aim":')) : '（模块缺席）'} rules=${coreRules?.kind === 'text' ? String(!coreRules.content.includes('aim')) : '（模块缺席）'}`,
    );
    check('生成指令口径＝下一步的行动选项/此刻并排的走法（task 与指令去重后）', allText.includes('下一步的行动选项') && allText.includes('并排的走法') && !allText.includes('为当前剧情提供'));
    check('任务指令收尾为 user 角色', result.messages[result.messages.length - 1]?.role === 'user');
    check('trace 全模块覆盖', result.trace.length === config.modules.length);

    // 外部槽位注入单步链路已由上方「非空即带」覆盖；再验证模块级启停
    // 开关的优先权：关掉 external 模块后即便 sources 供给也不注入
    // （modules[].enabled 保留的实证——引擎行为面，非 UI 面）
    const modulesOff = config.modules.map(m => (m.id === 'inject_external_slot' ? { ...m, enabled: false } : m));
    const offResult = assembleMessages(modulesOff, sources);
    const extTrace = offResult.trace.find(t => t.moduleId === 'inject_external_slot');
    check('模块开关优先（关掉后不注入）', extTrace?.injected === false, `note=${extTrace?.note ?? '（无 trace）'}`);

    // 池与模板的交付面锁：池侧扫 type/content/category 三面（题材硬编码
    // 主要落在分类名上，只扫正文会漏），模板侧四锁（规则 6 新元素边界／
    // 规则 7 直球位／输出契约标题与 aim 忠实性／few_shot 直球示例）——
    // 全是字面量锁，正文改字即翻红。
    const { masterPool } = buildAssetPool();
    const BANNED = ['商队', '义体', '尸群', '丧尸', '公会', '师门', '末世', '辐射', '黑客', '修炼', '境界', '法宝', '灵根', '战技', '魔法', '江湖', '内力', '骑士', '精灵', '星舰', '机甲', '异能', '学院', '神殿', '祭坛', '神明', '侦探', '宫廷', '王朝', '战斗异能', '权谋斗争', '末日生存', '校园职场', '奇幻冒险', '科幻未来', '推理调查'];
    // 三面各成一段再扫：字段直接相接会在边界拼出词表词造成假红。
    const bannedHits = (w: string) => masterPool.some(e => [e.type, e.content, e.category].join('\n').includes(w));
    check('asset：无题材硬编码残留（题材词表零命中）', !BANNED.some(bannedHits), BANNED.filter(bannedHits).join('/'));
    check('写作规则锁「直接回应」直球位', allText.includes('至少一条选项是对它的直接回应') && allText.includes('不绕开、不岔走'));
    check('输出契约锁标题与 aim 忠实性', allText.includes('核心动作') && allText.includes('不许埋在修饰里') && allText.includes('不得与正文动作相悖'));
    check('规则 6 锁新元素边界（背景服务＋不得偷走这一拍）', allText.includes('只能作背景') && allText.includes('不得偷走这一拍') && allText.includes('新元素不许把它挤掉'));
    check('few_shot 直球示例换血（岔开话题退役）', allText.includes('痛快应下') && !allText.includes('岔开话题'));

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

    // aim（只进显示与存档的元信息）：主契约带 aim 时提取；缺 aim 的两条
    // 来源——旧契约输出与括号回退路径——一律不带该键
    const aimJson = '{"options":[{"title":"A","content":"甲","aim":"撬出对方底牌"},{"title":"B","content":"乙"}]}';
    const aimReport = parseOptions(aimJson, 4);
    check(
        '解析：主契约提取 aim（显示侧「这条想撬动什么」的来源）',
        aimReport.path === 'json' && aimReport.options[0]?.aim === '撬出对方底牌',
        `aim=${String(aimReport.options[0]?.aim)}`,
    );
    const aimAbsent = aimReport.options[1];
    check(
        '解析：元素缺 aim 不带该键（旧契约输出与括号回退路径同此形态，读侧一律容忍）',
        aimAbsent !== undefined && !('aim' in aimAbsent) && !('aim' in (report.options[0] ?? {})),
        `json=${Object.keys(aimAbsent ?? {}).join('|')} 回退=${Object.keys(report.options[0] ?? {}).join('|')}`,
    );
    // 归一：非字符串（模型爱写 null）与纯空白都按缺席处理，与缺键同义
    const oddAimJson = '{"options":[{"title":"A","content":"甲","aim":null},{"title":"B","content":"乙","aim":"   "}]}';
    const oddAimReport = parseOptions(oddAimJson, 4);
    check(
        '解析：aim 非字符串（null）与纯空白归一为缺席（显示侧「在场才渲染」的判据）',
        oddAimReport.options.length === 2 && oddAimReport.options.every(o => !('aim' in o)),
        `keys=${oddAimReport.options.map(o => Object.keys(o).join('|')).join(' / ')}`,
    );

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

    // ---- 解析尾部分流六形态（容器闭合校验＋尾部契约锚点校验）----
    // A 容器收口＋尾部中文散文：收口即采信，不再误报「部分恢复」徽标
    const closedProseRaw = [
        '{"options": [',
        '\n    {"title": "甲", "content": "甲的行动正文，走向河边的旧渡口。"}',
        '\n]}',
        '\n以上就是可选的行动方向，请选择其一继续剧情。',
    ].join('');
    const closedProseReport = parseOptions(closedProseRaw, 4);
    check(
        '尾部分流：容器收口＋尾部中文散文 → json 主路径 1 条、无丢弃计数',
        closedProseReport.path === 'json' && closedProseReport.options.length === 1 && closedProseReport.dropped === undefined,
        `path=${closedProseReport.path} count=${closedProseReport.options.length}`,
    );

    // B 收口＋尾部无锚点结构残渣：残渣不含契约陈述＝无害，采信
    const closedInertRaw = [
        '{"options": [',
        '\n    {"title": "甲", "content": "甲的行动正文，走向河边的旧渡口。"}',
        '\n]}',
        '\n{"note": "模型附带的收尾备注"}',
    ].join('');
    const closedInertReport = parseOptions(closedInertRaw, 4);
    check(
        '尾部分流：容器收口＋尾部无锚点残渣 → json 主路径 1 条（无害残渣不连坐）',
        closedInertReport.path === 'json' && closedInertReport.options.length === 1,
        `path=${closedInertReport.path} count=${closedInertReport.options.length}`,
    );

    // C 收口点后跟垃圾（] 后不是 }）：破损流整批拒收，不静默接受
    const strayBracketRaw = [
        '{"options": [',
        '\n    {"title": "甲", "content": "甲的行动正文，走向河边的旧渡口。"}',
        '\n]]}',
    ].join('');
    const strayBracketReport = parseOptions(strayBracketRaw, 4);
    check(
        '尾部分流：收口点后跟多余 ] → json_reject 0 条（破损流不静默接受）',
        strayBracketReport.path === 'json_reject' && strayBracketReport.options.length === 0,
        `path=${strayBracketReport.path} count=${strayBracketReport.options.length}`,
    );

    // D 两份契约串接：闭合后残留含第二份契约陈述 → 整批拒收（不静默吞掉）
    const doubledRaw = [
        '{"options": [',
        '\n    {"title": "甲", "content": "甲的行动正文，走向河边的旧渡口。"}',
        '\n]}{"options": [{"title": "乙", "content": "乙的行动正文，转身返回议事厅。"}]}',
    ].join('');
    const doubledReport = parseOptions(doubledRaw, 4);
    check(
        '尾部分流：两份契约串接 → json_reject 0 条（第二份契约不静默丢弃）',
        doubledReport.path === 'json_reject' && doubledReport.options.length === 0,
        `path=${doubledReport.path} count=${doubledReport.options.length}`,
    );

    // F 元素间缺分隔符：分隔符严格校验拦截 → 整批拒收
    const noSepRaw = [
        '{"options": [',
        '\n    {"title": "甲", "content": "甲的行动正文，走向河边的旧渡口。"}',
        '\n    {"title": "乙", "content": "乙的行动正文，转身返回议事厅。"}',
        '\n]}',
    ].join('');
    const noSepReport = parseOptions(noSepRaw, 4);
    check(
        '尾部分流：元素间缺分隔符 → json_reject 0 条（分隔符严格校验）',
        noSepReport.path === 'json_reject' && noSepReport.options.length === 0,
        `path=${noSepReport.path} count=${noSepReport.options.length}`,
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
 * 请求形状终态机判：choice 出站由 TASK_PARAMS 固化项＋任务档案带出项
 * 组成——reasoning_effort high＋temperature 1＋stream true＋json_object
 * response_format 四件套锁定（档案缺席＝默认档的出站形态）。
 */
function runConstantRequestChecks(): void {
    const messages = [{ role: 'user' as const, content: 'x' }];
    const body = buildGenerateBody(messages, {
        task: 'choice',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        temperature: TASK_PARAMS.choice.defaultTemperature,
        stream: TASK_PARAMS.choice.stream,
        outputContract: TASK_PARAMS.choice.outputContract,
        reasoningEffort: TASK_PARAMS.choice.defaultReasoningEffort,
        timeoutSec: TASK_PARAMS.choice.timeoutSec,
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
 * 0 条选项失败文案机判：判据是「正文是否为空」而非「path 是否 empty」——
 * path=empty 同时覆盖真空响应与纯散文／拒答语／空数组等「模型其实有输出」
 * 的形态，只看 path 会把后者误报成「模型未返回内容」并抹掉原文。
 */
function runZeroOptionMessageChecks(): void {
    const emptyMessage = zeroOptionsMessage(parseOptions('', 4), '');
    check('零选项文案：正文为空（真·零响应）＝指向重试/换端点，不带原始输出前缀',
        emptyMessage.includes('未返回') && emptyMessage.includes('重试') && emptyMessage.includes('端点') && !emptyMessage.includes('原始输出'),
        `msg=${emptyMessage}`);
    // 纯空白是判据的判别样本：trim 语义下与空串同归「未返回内容」——
    // 若判据回退成 falsy 判空，此样本会落进原始输出臂（回归红线）
    const blankMessage = zeroOptionsMessage(parseOptions('  \n\t ', 4), '  \n\t ');
    check('零选项文案：纯空白正文同走「未返回内容」分支（空白判据＝trim 后为空，非 falsy）',
        blankMessage.includes('未返回') && blankMessage.includes('重试') && !blankMessage.includes('原始输出'),
        `msg=${blankMessage}`);
    const raw = '她聊起配置格式："options":[ 其实只是聊天正文';
    const rejectMessage = zeroOptionsMessage(parseOptions(raw, 4), raw);
    check('零选项文案：非 empty 路径保持原口径（路径＋原始输出前缀在场）',
        rejectMessage.includes('解析得到 0 条选项（路径 json_reject）') && rejectMessage.includes(`原始输出：${raw.slice(0, 500)}`),
        `msg=${rejectMessage.slice(0, 60)}`);
    // 关键形态：模型有输出但抽不出选项（path=empty 且正文非空）——不得套用
    // 「模型未返回任何内容」，且必须带出原文（用户要靠它判断模型说了什么）
    const prose = '今天天气不错我们出去走走';
    const proseReport = parseOptions(prose, 4);
    const proseMessage = zeroOptionsMessage(proseReport, prose);
    check('零选项文案：正文非空但抽不出选项（散文/拒答语）＝不得误报「未返回内容」且保留原文前缀',
        proseReport.path === 'empty' && proseMessage.includes('解析得到 0 条选项') && proseMessage.includes(`原始输出：${prose}`) && !proseMessage.includes('未返回'),
        `path=${proseReport.path} msg=${proseMessage.slice(0, 60)}`);
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

    // 失败面：任务模型未配置（请求未发出）由 generator 哨兵补记 ok:false
    const savedProfilesJson = JSON.stringify(readTaskProfiles());
    setChoiceProfile('', '');
    await generateOptions();
    const failRecord = runlog.records[runlog.records.length - 1];
    check('runlog：任务模型未配置失败落记录（ok=false、error 含「未配置选项生成模型」、requestText 在场）',
        !!failRecord && failRecord.ok === false && (failRecord.error ?? '').includes('未配置选项生成模型') && failRecord.requestText.length > 0,
        `ok=${String(failRecord?.ok)} error=${failRecord?.error ?? '无'}`);
    writeTaskProfiles(JSON.parse(savedProfilesJson) as TaskProfilesDomain);
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
            { task: 'choice', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-leak-canary', model: 'm1', stream: false, outputContract: 'prompt_only', timeoutSec: TASK_PARAMS.choice.timeoutSec },
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
        const savedProfilesJson = JSON.stringify(readTaskProfiles());
        const partialEndpoint = savedEndpoints[0] ?? createEndpoint('partial 端点');
        if (savedEndpoints.length === 0) writeApiDomain([partialEndpoint]);
        setChoiceProfile(partialEndpoint.id, partialEndpoint.models[0] ?? 'partial-model');
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
                    return {
                        read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true },
                        cancel: async () => undefined,
                    };
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
            writeTaskProfiles(JSON.parse(savedProfilesJson) as TaskProfilesDomain);
            if (savedEndpoints.length === 0) writeApiDomain([]);
            useChoiceStore().$reset();
        }
    }
}

/**
 * 生成超时机判（统一超时原语在 choice 路径上的四个事实）：①装的是 300 秒
 * 那一档（不是别的数，也不是不装）；②到点按失败可见报出（错误态＋runlog），
 * 不误报「已取消」；③外部取消仍归「已取消」；④取消与到点的竞态（取消先到）
 * 仍按超时报。③④必须成对：只钉③，「aborted 就报已取消」的写法照样全绿，
 * 而真实端点上用户会在毫秒内看到一句他没按过的「已取消」。
 *
 * 不真等 300 秒：把 setTimeout 换成记录延时的桩，命中该延时就改为手动触发
 * （①②立即触发、④在取消之后触发），「到点中止」因此同步可测。fetch 桩照
 * 真实 fetch 的中止语义——收到 abort（或进场时已中止）即以 AbortError 拒绝；
 * 不这样桩就测不出到点中止的后果，死端点恰恰就是这个样子（请求发出去再无
 * 动静）。
 */
async function runTimeoutChecks(): Promise<void> {
    const savedEndpoints = readApiDomain();
    const savedProfilesJson = JSON.stringify(readTaskProfiles());
    const endpoint = savedEndpoints[0] ?? createEndpoint('超时冒烟端点');
    if (savedEndpoints.length === 0) writeApiDomain([endpoint]);
    setChoiceProfile(endpoint.id, endpoint.models[0] ?? 'timeout-model');
    const runlog = useRunlogStore();
    const store = useChoiceStore();
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    let fetchEntered = false;
    const hangingFetch = (): typeof fetch => (async (_url: string, init?: RequestInit) => {
        fetchEntered = true;
        return new Promise((_resolve, reject) => {
            const fail = (): void => {
                const aborted = new Error('The operation was aborted.');
                aborted.name = 'AbortError';
                reject(aborted);
            };
            if (init?.signal?.aborted) fail();
            else init?.signal?.addEventListener('abort', fail);
        });
    }) as unknown as typeof fetch;
    try {
        // ①＋②：到点中止（300 秒那一档被即时触发）
        const delays: number[] = [];
        globalThis.fetch = hangingFetch();
        globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
            delays.push(Number(delay));
            if (Number(delay) === TASK_PARAMS.choice.timeoutSec * 1000) {
                handler(...args);
                return 0;
            }
            return originalSetTimeout(handler, delay, ...args);
        }) as unknown as typeof setTimeout;
        runlog.clear();
        store.$reset();
        await generateOptions();
        const timeoutRecord = runlog.records[runlog.records.length - 1];
        check('生成超时：choice 请求装的是 300 秒上限（定时器延时机判——不是别的数，也不是不装）',
            TASK_PARAMS.choice.timeoutSec === 300 && delays.includes(300_000),
            `timeoutSec=${TASK_PARAMS.choice.timeoutSec} delays=${JSON.stringify(delays)}`);
        check('生成超时：到点按失败可见报出（错误态带「请求超时（300 秒）」、runlog 记 ok=false），不误报「已取消」',
            store.phase === 'error' && store.error.includes('请求超时（300 秒）') && !store.error.includes('已取消')
            && !!timeoutRecord && !timeoutRecord.ok && (timeoutRecord.error ?? '').includes('请求超时（300 秒）'),
            `phase=${store.phase} error=${store.error} runlog=${timeoutRecord?.error ?? '无'}`);

        // ③：外部取消（真实定时器，只等请求发出）
        globalThis.setTimeout = originalSetTimeout;
        fetchEntered = false;
        globalThis.fetch = hangingFetch();
        runlog.clear();
        store.$reset();
        const pending = generateOptions();
        for (let i = 0; i < 100 && !fetchEntered; i++) {
            await new Promise(resolve => originalSetTimeout(resolve, 5));
        }
        cancelGeneration();
        await pending;
        check('生成取消：外部取消仍报「已取消」（超时与取消两个语义分流未混走）',
            store.phase === 'error' && store.error === '已取消',
            `phase=${store.phase} error=${store.error}`);

        // ④竞态：取消先到、到点随后（同一次请求窗口内）——到点已成立时不得被
        // 改写成「已取消」。这条专门钉传输层的超时判定：只把 ③ 钉住的话，
        // 「aborted 就报已取消」的写法照样全绿，而真实端点上用户会在毫秒内
        // 先看到一句「已取消」——他没按过任何东西。
        let fireTimeout = (): void => undefined;
        globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
            if (Number(delay) === TASK_PARAMS.choice.timeoutSec * 1000) {
                fireTimeout = () => handler(...args);
                return 0;
            }
            return originalSetTimeout(handler, delay, ...args);
        }) as unknown as typeof setTimeout;
        fetchEntered = false;
        globalThis.fetch = hangingFetch();
        runlog.clear();
        store.$reset();
        const racing = generateOptions();
        for (let i = 0; i < 100 && !fetchEntered; i++) {
            await new Promise(resolve => originalSetTimeout(resolve, 5));
        }
        cancelGeneration();
        fireTimeout();
        await racing;
        check('生成超时：取消与到点竞态（取消先到、到点随后）仍按超时报，不被改写成「已取消」',
            store.phase === 'error' && store.error.includes('请求超时（300 秒）') && !store.error.includes('已取消'),
            `phase=${store.phase} error=${store.error}`);

        // 任务模型未配置文案：任务中文名注入、裸 taskId 不进用户可见文本
        const missingMessage = missingTaskModelError('choice').message;
        check('文案：未配置任务模型带任务中文名「选项生成」且无裸 taskId（apis 层单点构造器）',
            missingMessage.includes('未配置选项生成模型') && missingMessage.includes('「选项生成」') && !missingMessage.includes('choice'),
            `msg=${missingMessage}`);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalSetTimeout;
        writeTaskProfiles(JSON.parse(savedProfilesJson) as TaskProfilesDomain);
        if (savedEndpoints.length === 0) writeApiDomain([]);
        store.$reset();
    }
}

/**
 * 任务路由单通道机判：未配置/悬空/缺模型 fail fast＋可调参数语义
 * （写档带出、缺席＝TASK_PARAMS 默认档、温度钳 0-2/非数剔除、思考枚举外剔除）。
 */
function runTaskRouteChecks(): void {
    const savedEndpoints = readApiDomain();
    const savedProfilesJson = JSON.stringify(readTaskProfiles());
    try {
        writeApiDomain([{ id: 'tp-p', name: '档案服务商', url: 'https://tp.example.com/v1', key: 'sk-tp', models: ['m-a'], noPrefill: false }]);
        setChoiceProfile('', '');
        check('任务路由：档案行空＝null（未配置 fail fast 语义）', resolveTaskRoute('choice') === null);
        setChoiceProfile('no-such-provider', 'm-a');
        check('任务路由：服务商悬空＝null', resolveTaskRoute('choice') === null);
        setChoiceProfile('tp-p', '');
        check('任务路由：缺模型＝null', resolveTaskRoute('choice') === null);
        mutateTaskProfiles(profiles => {
            profiles.choice = { providerId: 'tp-p', model: 'm-a', temperature: 1.3, reasoningEffort: 'low' };
        });
        const route = resolveTaskRoute('choice');
        check('任务路由：写档后带出所写值（url/key/model/温度/思考同点解析）',
            !!route && route.url === 'https://tp.example.com/v1' && route.key === 'sk-tp'
            && route.model === 'm-a' && route.temperature === 1.3 && route.reasoningEffort === 'low',
            `route=${JSON.stringify(route)}`);
        setChoiceProfile('tp-p', 'm-a');
        const defaultRoute = resolveTaskRoute('choice');
        check('任务路由：温度/思考缺席＝TASK_PARAMS 任务默认档',
            !!defaultRoute && defaultRoute.temperature === TASK_PARAMS.choice.defaultTemperature
            && defaultRoute.reasoningEffort === TASK_PARAMS.choice.defaultReasoningEffort);
        mutateTaskProfiles(profiles => {
            profiles.choice = { providerId: 'tp-p', model: 'm-a', temperature: 9, reasoningEffort: 'ultra' as never };
        });
        const clamped = readTaskProfiles().choice;
        check('任务档案 normalize：温度越界钳 0-2、思考枚举外剔除',
            clamped.temperature === 2 && clamped.reasoningEffort === undefined,
            `p=${JSON.stringify(clamped)}`);
        mutateTaskProfiles(profiles => {
            profiles.choice = { providerId: 'tp-p', model: 'm-a', temperature: -3, reasoningEffort: 'high' };
        });
        const clampedLow = readTaskProfiles().choice;
        check('任务档案 normalize：温度下界钳 0', clampedLow.temperature === 0 && clampedLow.reasoningEffort === 'high');
        mutateTaskProfiles(profiles => {
            profiles.choice = { providerId: 'tp-p', model: 'm-a', temperature: Number.NaN };
        });
        const dropped = readTaskProfiles().choice;
        check('任务档案 normalize：非数温度剔除（回任务默认档语义）',
            dropped.temperature === undefined && dropped.model === 'm-a');
    } finally {
        writeTaskProfiles(JSON.parse(savedProfilesJson) as TaskProfilesDomain);
        writeApiDomain(savedEndpoints);
    }
}

/**
 * 生成参数换代迁移机判：按值判只对换代标记（genDefaultsV）缺席的存量档
 * 生效一次，标记随首个读通道落盘——用户此后显式写回旧默认值也守得住
 * （按值判本身区分不了「旧默认存量」与「用户写旧值」，标记把时代分开）。
 */
function runGenParamMigrationChecks(): void {
    const saved = getGlobal(GLOBAL_CHOICE_KEY);
    // 夹具直写未归一形状（迁移机判的前提就是「存档里就是这种半截形状」）——
    // 域登记门管键不管值形状，写出形状在此显式断言
    const writeRawDomain = (value: unknown): void => {
        setGlobal(GLOBAL_CHOICE_KEY, value as unknown as ChoiceDomain);
    };
    const writeRawGen = (gen: Partial<ChoiceGenParams>): void => {
        writeRawDomain({ gen });
    };
    try {
        writeRawGen({ count: 4, minChars: 10, maxChars: 60 });
        const migrated = choiceStorage.readDomain().gen;
        check(
            '生成参数迁移：存量档三值＝旧默认（4/10/60）→ 读侧换成新默认（30/120）',
            migrated.count === 4 && migrated.minChars === 30 && migrated.maxChars === 120,
            `count=${migrated.count} min=${migrated.minChars} max=${migrated.maxChars}`,
        );
        const persisted = getGlobal(GLOBAL_CHOICE_KEY);
        check(
            '生成参数迁移：存量档迁移随读通道落盘（值换新＋换代标记写入）',
            persisted?.genDefaultsV === 1 && persisted?.gen?.minChars === 30,
            `v=${String(persisted?.genDefaultsV)} min=${String(persisted?.gen?.minChars)}`,
        );
        writeRawGen({ count: 6, minChars: 10, maxChars: 60 });
        const kept = choiceStorage.readDomain().gen;
        check(
            '生成参数迁移：存量档任一值自设（count=6）→ 三值原样保留',
            kept.count === 6 && kept.minChars === 10 && kept.maxChars === 60,
            `count=${kept.count} min=${kept.minChars} max=${kept.maxChars}`,
        );
        writeRawDomain({ gen: { count: 4, minChars: 10, maxChars: 60 }, genDefaultsV: 1 });
        const held = choiceStorage.readDomain().gen;
        check(
            '生成参数迁移：换代标记在场 → 用户显式写旧默认（4/10/60）也原样守住',
            held.count === 4 && held.minChars === 10 && held.maxChars === 60,
            `count=${held.count} min=${held.minChars} max=${held.maxChars}`,
        );
    } finally {
        // 还原存回原值（不存 readDomain 的归一投影：那会把夹具没写过的
        // 默认字段补进存储，与「本区不留残」的纪律相悖）
        setGlobal(GLOBAL_CHOICE_KEY, saved);
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
    runZeroOptionMessageChecks();
    runConstantRequestChecks();
    runTaskRouteChecks();
    await runDebugForceRawChecks();
    await runRunlogChecks();
    await runTimeoutChecks();
    console.info('=== choice 池抽取/asset 同步/注入/自动生成机判 ===');
    runPoolChecks();
    runPoolKnobChecks();
    runAssetPoolChecks();
    runInjectionChecks();
    await runAutoGenerateChecks();
    await runFloorPersistChecks();
    await runApplyOptionChecks();
    runGenParamMigrationChecks();
    if (failures.length > 0) {
        console.error(`[choice-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[choice-smoke] OK：组装注入逐项可见、占位符替换、trace 覆盖、解析回退确定性触发、debugForceRaw 生成管线接线全部通过；池抽取分布/数学、池旋钮贯通（UI 写面→normalize→resolver：trim 截断/末段打乱开与关两侧）、asset 同步（130 条/9 分类/首次翻转/幂等不回翻/污染恢复）、池注入分区、MESSAGE_RECEIVED 守卫链全部通过；楼层落盘（roundtrip/saveChat 通道/刷新恢复/切聊天/重 roll 作废/swipe 跟随/删楼重载/写侧守门/坏档回退）全部通过；生成超时与取消两语义分流（300 秒上限机判/到点按失败可见报出/外部取消仍归已取消/取消与到点竞态仍按超时报）＋未配置任务模型文案单点机判通过。');
}
