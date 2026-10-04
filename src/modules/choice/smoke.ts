/**
 * node 冒烟的批B 机判部分：组装纯函数路径＋解析回退确定性触发。
 *
 * 设计：直接驱动引擎纯函数（合成 AssemblySources——不依赖宿主在场
 * 数据，断言确定性），与浏览器真实数据共用同一条 assembleMessages/
 * parseOptions 代码路径（dist 加载即覆盖）。输出 PASS/FAIL 行供
 * scripts/smoke.mjs 收口断言。
 */
import { assembleMessages, createDefaultPromptConfig, renderDump, renderTraceCompact, type AssemblySources, type HistoryEntry, type PoolInjectionSupply } from '@/prompts';
import { buildGenerateBody, extension_settings } from '@/host';
import { DEBUG_MALFORMED_RAW, parseOptions } from './parse';
import { choiceStorage } from './api';
import { generateOptions } from './generator';
import { useChoiceStore } from './store';
import { drawAmount, effectivePool, resolvePool, resolvePoolConfig, safeWeight } from './pool/resolver';
import type { PoolEntry } from './pool/types';
import { exportPoolBackup, importLegacyChoice, parsePoolBackup } from './pool/import';
import { deletePoolConfig, readChatPoolConfigId, readPoolData, setChatPoolConfigId, upsertPoolConfig, upsertPoolEntry } from './pool/storage';
import { ASSET_POOL_CONFIG_ID, ASSET_POOL_VERSION, buildAssetPool, syncAssetPool } from './pool/asset';

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
// 批C 机判：池抽取 / 导入 / 注入 / 绑定 / 自动生成
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
}

/**
 * 1.5) 池 asset（批C.2 只读化）：内置池静态形状＋syncAssetPool 行为机判。
 *
 * 顺序契约：本区放在导入往返之前，且结尾把池域重置回空——导入断言的
 * 前置条件是「导入前池=空」（模拟全新安装），而 initChoiceMinimal 的
 * asset 同步已经落过 110 条，不重置会让导入后条目数变成 113。
 */
function runAssetPoolChecks(): void {
    // ---- 静态形状（纯函数，不依赖存储态）----
    const { masterPool, poolConfigs } = buildAssetPool();
    check('asset：内置池 110 条（112−2 重复）', masterPool.length === 110, `实际 ${masterPool.length}`);
    const cats = new Set(masterPool.map(e => e.category));
    check('asset：整理后 17 个分类（20−3 合并）', cats.size === 17, `实际 ${cats.size}`);
    const transition = masterPool.find(e => e.type === '转场推进');
    check('asset：转场推进转固定（pinned）', !!transition && transition.pinned, `pinned=${String(transition?.pinned)}`);
    check(
        'asset：配置唯一且默认（asset-default）',
        poolConfigs.length === 1 && poolConfigs[0].id === ASSET_POOL_CONFIG_ID && poolConfigs[0].isDefault,
        `configs=${poolConfigs.length} id=${poolConfigs[0]?.id}`,
    );
    check('asset：引用层全量镜像', poolConfigs[0].entries.length === masterPool.length, `refs=${poolConfigs[0].entries.length}/${masterPool.length}`);
    check('asset：池层不再携带规则（v3：反 OOC 要点并入提示词模板 core_rules）', poolConfigs.every(c => !('rules' in c)), `带 rules 配置 ${poolConfigs.filter(c => 'rules' in c).length}`);
    const ids = new Set(masterPool.map(e => e.id));
    check('asset：条目 id 确定性且唯一（asset-<序号>）', ids.size === masterPool.length && masterPool[0].id === 'asset-1', `唯一 ${ids.size}/${masterPool.length} 首条 ${masterPool[0]?.id}`);
    // v2（m03158 拍板）条目级 rule 移除；v3（m03359 整合轮）连数据形状都不带
    check('asset：条目规则字段移除（v3，数据形状不再含 rule）', masterPool.every(e => !('rule' in e)), `带 rule 条目 ${masterPool.filter(e => 'rule' in e).length}`);

    // ---- 同步行为（存储态驱动）----
    const resetPool = () => {
        choiceStorage.writeDomain(d => {
            d.pool = { masterPool: [], poolConfigs: [] };
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
    upsertPoolEntry({ id: 'smoke-junk', type: '垃圾', content: '应被覆盖', category: 'x', pinned: false, weight: 1 });
    choiceStorage.writeDomain(d => {
        d.pool.assetVersion = 0;
    });
    syncAssetPool();
    domain = choiceStorage.readDomain();
    check(
        'asset 版本变更：污染池全量恢复（垃圾清除、配置归一、gen 不动）',
        domain.pool.masterPool.length === 110 && !domain.pool.masterPool.some(e => e.id === 'smoke-junk') && domain.pool.poolConfigs.length === 1 && domain.pool.assetVersion === ASSET_POOL_VERSION && domain.gen.categoriesEnabled === false,
        `条目 ${domain.pool.masterPool.length} v=${String(domain.pool.assetVersion)}`,
    );
    // 还原导入测试前置：导入断言假定「导入前池=空」（模拟全新安装）
    resetPool();
}

/** 2) 导入往返：\r fixture（假密钥）→导入→读出→导出→字段级 diff＋幂等。 */
function runImportRoundTrip(): void {
    // fixture 形状＝用户实证 extension_settings.choice（密钥一律假值）
    const fixture = {
        master_pool: [
            { id: 'e1\r', category: '探索', type: '检查酒馆', content: '仔细检查酒馆的每个角落', rule: '保持警惕口吻', pinned: false, weight: 1 },
            { id: 'e2\r', category: '探索', type: '打听消息', content: '向酒保打听最近传闻', rule: '', pinned: false, weight: 3 },
            { id: 'e3', category: '社交', type: '闲聊', content: '和邻座搭话', rule: '', pinned: false, weight: 1 },
        ],
        configs: [
            {
                id: 'c1', name: '旧配置', is_default: true,
                rules: '禁止 OOC：所有选项必须是角色在当前场景可以真实执行的行动。',
                entries: [
                    { entry_id: 'e1\r', enabled: true, pinned: true, weight: 2 },
                    { entry_id: 'e2\r', enabled: false, pinned: false, weight: 1 },
                ],
                generation: { categories_enabled: false, count_mode: '4', dedup_enabled: true, dedup_threshold: 0.75, oversample_pct: 80, pinned_overflow: 'send_all', shuffle_final: true },
            },
        ],
        apis: [
            { id: 'a1', name: '旧端点一', apiurl: 'https://fake.example.com/v1', key: 'sk-fake-0001', model: 'fake-model-a', stream: false, temperature: 0.5, max_tokens: 1024, exclude_params: '', timeout: 180 },
            { id: 'a2', name: '旧端点二', apiurl: 'https://fake.example.org/v1', key: 'sk-fake-0002', model: 'fake-model-b', stream: false, temperature: 1, max_tokens: 512, exclude_params: '', timeout: 60 },
        ],
        active_api_id: 'a2\r',
        auto_generate: true,
        stats: { foo: 1 },
        ui: { bar: 2 },
    };
    (extension_settings as { choice?: unknown }).choice = fixture;

    const report = importLegacyChoice();
    if (!report) {
        check('导入：fixture 被识别（readLegacyChoice 命中）', false);
        return;
    }

    const { masterPool, poolConfigs } = readPoolData();
    check(
        '导入：master_pool 3 条全部导入（\\r id 已 trim；条目 rule 按新契约丢弃）',
        report.masterPoolImported === 3 && masterPool.length === 3 && masterPool.every(e => !e.id.includes('\r')) && masterPool.some(e => e.id === 'e1' && e.type === '检查酒馆' && e.content === '仔细检查酒馆的每个角落' && !('rule' in e) && e.weight === 1) && report.notes.some(n => n.includes('条目级规则已弃')),
        `imported=${report.masterPoolImported}`,
    );
    const cfg = poolConfigs.find(c => c.id === 'c1');
    check(
        '导入：configs 1 套导入（entry_id 同步规范化；停用引用保留；rules 丢弃）',
        report.configsImported === 1 && !!cfg && cfg.isDefault && !('rules' in cfg) && cfg.entries.length === 2 && cfg.entries[0].entryId === 'e1' && cfg.entries[0].pinned === true && cfg.entries[0].weight === 2 && cfg.entries[1].entryId === 'e2' && cfg.entries[1].enabled === false,
        `imported=${report.configsImported}`,
    );
    const domain = choiceStorage.readDomain();
    const apiA1 = domain.apis.find(a => a.id === 'a1');
    check(
        '导入：apis 2 个直映（outputContract/reasoningEffort 缺省填）',
        report.apisImported === 2 && !!apiA1 && apiA1.name === '旧端点一' && apiA1.apiurl === 'https://fake.example.com/v1' && apiA1.key === 'sk-fake-0001' && apiA1.model === 'fake-model-a' && apiA1.stream === false && apiA1.temperature === 0.5 && apiA1.maxTokens === 1024 && apiA1.outputContract === 'json_object' && apiA1.reasoningEffort === 'off',
        `imported=${report.apisImported}`,
    );
    check(
        '导入：gen 映射（count_mode→count、oversample_pct、auto_generate）',
        domain.gen.count === 4 && domain.gen.oversamplePct === 80 && domain.gen.autoGenerate === true && domain.gen.categoriesEnabled === false && domain.gen.pinnedOverflow === 'send_all' && domain.gen.shuffleFinal === true,
        `count=${domain.gen.count} pct=${domain.gen.oversamplePct}`,
    );
    check('导入：active_api_id 命中直映', domain.activeApiId === 'a2', `activeApiId=${domain.activeApiId}`);
    check(
        '导入：未识别字段进忽略清单（stats/ui/dedup_*/exclude_params/timeout/rules）',
        report.ignoredFields.includes('stats') && report.ignoredFields.includes('ui') && report.ignoredFields.some(f => f.startsWith('configs[].generation.dedup_enabled')) && report.ignoredFields.some(f => f.startsWith('apis[].exclude_params')) && report.ignoredFields.some(f => f.startsWith('apis[].timeout')) && report.ignoredFields.some(f => f.startsWith('configs[].rules')),
        `ignored=${report.ignoredFields.join('、')}`,
    );

    // 导出→解析→字段级 diff 零丢失
    const backupText = exportPoolBackup();
    const parsed = parsePoolBackup(backupText);
    let roundtripOk = parsed.ok;
    if (parsed.ok) {
        const backup = parsed.data;
        const byId = new Map(backup.masterPool.map(e => [e.id, e]));
        for (const raw of fixture.master_pool) {
            // 条目 rule 按新契约不保真（导入即丢弃）——往返 diff 不比对 rule
            const entry = byId.get(raw.id.trim());
            if (!entry || entry.type !== raw.type || entry.content !== raw.content || entry.category !== raw.category || entry.pinned !== raw.pinned || entry.weight !== raw.weight) roundtripOk = false;
        }
        const backupCfg = backup.poolConfigs.find(c => c.id === 'c1');
        if (!backupCfg || ('rules' in backupCfg) || backupCfg.isDefault !== true) roundtripOk = false;
        else {
            const refById = new Map(backupCfg.entries.map(r => [r.entryId, r]));
            for (const raw of fixture.configs[0].entries) {
                const ref = refById.get(raw.entry_id.trim());
                if (!ref || ref.enabled !== raw.enabled || ref.pinned !== raw.pinned || ref.weight !== raw.weight) roundtripOk = false;
            }
        }
        const apiById = new Map(backup.apis.map(a => [a.id, a]));
        for (const raw of fixture.apis) {
            const api = apiById.get(raw.id);
            if (!api || api.name !== raw.name || api.apiurl !== raw.apiurl || api.key !== raw.key || api.model !== raw.model || api.stream !== raw.stream || api.temperature !== raw.temperature || api.maxTokens !== raw.max_tokens) roundtripOk = false;
        }
        if (backup.gen.count !== 4 || backup.gen.oversamplePct !== 80 || backup.gen.autoGenerate !== true || backup.activeApiId !== 'a2') roundtripOk = false;
    }
    check('导入往返：导出→解析→字段级零丢失', roundtripOk, parsed.ok ? '' : `error=${parsed.error}`);

    // 幂等：重复导入零新增
    const second = importLegacyChoice();
    check(
        '导入幂等：重复导入零新增（3/1/2 全跳过）',
        !!second && second.masterPoolImported === 0 && second.configsImported === 0 && second.apisImported === 0 && second.masterPoolSkipped === 3 && second.configsSkipped === 1 && second.apisSkipped === 2,
        `second=${second ? `${second.masterPoolImported}/${second.configsImported}/${second.apisImported}` : 'null'}`,
    );

    // 校验器拒畸形
    const bad1 = parsePoolBackup('这不是 json{');
    const bad2 = parsePoolBackup('{"kind":"other","version":1}');
    const bad3 = parsePoolBackup('{"kind":"tt-toolkit-pool-backup","version":2}');
    const bad4 = parsePoolBackup('{"kind":"tt-toolkit-pool-backup","version":1,"masterPool":{},"poolConfigs":[],"apis":[]}');
    check('导入：畸形备份文本被校验器拒绝', !bad1.ok && !bad2.ok && !bad3.ok && !bad4.ok, `样本结果：${[bad1.ok, bad2.ok, bad3.ok, bad4.ok].join('/')}`);
}

/** 3) 注入：pool_entries 模块的分区呈现与空态（m03359：池规则并入模板，独立段已删）。 */
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

    // m03359 整合轮：池规则不再独立注入——<pool_rules> 段缺席，反 OOC 要点
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

/** 4) 绑定级联：chat 覆盖命中→默认回退；effectivePool 两层语义。 */
function runBindingCascadeChecks(): void {
    // 前置：runImportRoundTrip 已落 c1（默认）＋e1/e2/e3
    upsertPoolConfig({ id: 'c2', name: '第二套', isDefault: false, entries: [{ entryId: 'e3', enabled: true, pinned: false, weight: 1 }] });
    const configs = readPoolData().poolConfigs;

    setChatPoolConfigId('c2');
    check('绑定级联：chat 域命中非默认配置', resolvePoolConfig(configs, readChatPoolConfigId())?.id === 'c2');
    setChatPoolConfigId('bogus');
    check('绑定级联：无效 id 回退默认配置', resolvePoolConfig(configs, readChatPoolConfigId())?.id === 'c1');
    setChatPoolConfigId('');
    check('绑定级联：空串＝用默认配置', resolvePoolConfig(configs, readChatPoolConfigId())?.id === 'c1');

    const { masterPool } = readPoolData();
    check('effectivePool：无配置回退全池', effectivePool(masterPool, null).length === 3);
    const c1 = configs.find(c => c.id === 'c1');
    const pool1 = c1 ? effectivePool(masterPool, c1) : [];
    check('effectivePool：引用层覆盖（停用剔除＋pinned/weight 覆盖）', pool1.length === 1 && pool1[0]?.id === 'e1' && pool1[0]?.pinned === true && pool1[0]?.weight === 2);
    // 双复核 P3 回归：0/负权＝近零权（fork「实质禁用」语义），坏数据回等权
    check('safeWeight：0/负权压到近零、非数值回等权（fork 语义）', safeWeight(0) === safeWeight(-1) && safeWeight(0) < 1e-6 && safeWeight('x') === 1);

    // 清场：绑定回默认、删测试配置（后续自动生成断言用干净的 c1 态）
    setChatPoolConfigId('');
    deletePoolConfig('c2');
}

/** 冒烟 stub 访问（scripts/smoke.mjs 注入；类型只声明本文件用到的面）。 */
interface SmokeStubs {
    eventSource: { emit(type: string, ...args: unknown[]): unknown };
    getContext(): { chat: unknown[] };
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
    // 清掉批B debugForceRaw 遗留的会话态——跳过类断言的基准是「零选项、
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
    emitReceived(0, 'normal');
    check('自动生成：首楼（messageId===0）跳过', store.phase === 'idle' && store.options.length === 0);
    // 双复核 P3 回归：分组消息 (chat_id, type) 形态的纯数字串不当楼层索引
    emitReceived('2', 'normal');
    check('自动生成：非数字 messageId 跳过（分组 chat_id 形态不误判）', store.phase === 'idle' && store.options.length === 0);
    choiceStorage.updateGenParams({ autoGenerate: false });
    emitReceived(2, 'normal');
    check('自动生成：autoGenerate=false 跳过', store.phase === 'idle' && store.options.length === 0);
    choiceStorage.updateGenParams({ autoGenerate: true });

    // 无 API：悬空 activeApiId → resolveActiveApi null → console.warn（不弹 UI）
    const savedActiveApi = choiceStorage.readDomain().activeApiId;
    choiceStorage.setActiveApi('no-such-api');
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warns.push(args.map(String).join(' '));
    };
    emitReceived(2, 'normal');
    console.warn = origWarn;
    check('自动生成：API 未配 console.warn 跳过（不弹 UI）', store.phase === 'idle' && warns.some(w => w.includes('自动生成跳过') && w.includes('API 未配置')), `warns=${warns.length}`);
    choiceStorage.setActiveApi(savedActiveApi);

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
    // 生成管线现场抽取池：drawPoolInjection 读导入后的池（e1 必发；条目渲染无规则后缀）
    check('自动生成：生成管线现场抽取池（dump 必发条目可见）', store.lastDump.includes('<pool_entries>') && store.lastDump.includes('检查酒馆：仔细检查酒馆的每个角落') && !store.lastDump.includes('[规则:'));
}

/** 组装纯函数路径机判（默认模板集＋合成源）。 */
function runAssemblyChecks(): string {
    const config = createDefaultPromptConfig();
    const sources = syntheticSources();
    const result = assembleMessages(config.modules, sources);

    const allText = result.messages.map(m => m.content).join('\n');

    // dump 断言核心（批B 判据）：各注入逐项可见
    check('人设注入可见（<persona> 段含 persona 正文）', allText.includes('<persona>') && allText.includes('王玉，28 岁'));
    check('角色卡描述注入可见（<character> 段）', allText.includes('<character>') && allText.includes('林霜，表面温婉'));
    check('角色卡性格注入可见（<personality> 段）', allText.includes('表面温和，回避直接冲突'));
    check('角色卡场景注入可见（<scenario> 段）', allText.includes('现代都市职场'));
    check('世界书前插注入可见（<world_info> 段）', allText.includes('一栋老写字楼'));
    check('世界书深度桶（深组）注入可见', allText.includes('【三年前】'));
    check('聊天历史注入（末条 AI 楼层 <current_scene> 包裹）', allText.includes('<current_scene>') && allText.includes('她垂下眼帘'));
    check('story_direction 注入可见（<direction> 段＝预设正文＋自由文本拼接）', allText.includes('<direction>') && allText.includes('未解之谜') && allText.includes('重点描写她的回避态度'));
    // G4 走向重设计：自由文本为主＋预设拼接；两者皆空＝模块按未启用处理
    const emptyDirection = assembleMessages(config.modules, { ...sources, storyDirection: { presetText: '', freeText: '' } });
    const emptyDirTrace = emptyDirection.trace.find(t => t.moduleId === 'inject_story_direction');
    check('story_direction 两者皆空＝不注入（trace 留痕）', emptyDirTrace?.injected === false && emptyDirTrace.note.includes('未设置'), `note=${emptyDirTrace?.note ?? '（无 trace）'}`);
    const freeOnlyDirection = assembleMessages(config.modules, { ...sources, storyDirection: { presetText: '', freeText: '重点描写她的回避态度' } });
    const freeOnlyText = freeOnlyDirection.messages.map(m => m.content).join('\n');
    check('story_direction 仅自由文本也注入（无预设可用）', freeOnlyText.includes('<direction>') && freeOnlyText.includes('重点描写她的回避态度') && !freeOnlyText.includes('未解之谜'));
    // 默认关的模块（外部搬运模块本体参与管线，但默认无勾选/开关关闭）：
    // baibai 合成源传 null → trace 记录未注入原因（默认关的可观测性）
    const baibaiTrace = result.trace.find(t => t.moduleId === 'inject_baibai');
    check('柏宝书默认关＝不注入且 trace 留痕', baibaiTrace?.injected === false && baibaiTrace.note.includes('不可用'), `note=${baibaiTrace?.note ?? '（无 trace）'}`);
    // 外部槽位：合成源给了已勾选槽位内容 → 注入可见（勾选即生效单步链路）。
    // 逐槽位标注：内容段带槽位 key 前缀、trace note 同粒度（逐项可见到槽位）
    check('外部注入槽位搬入可见（<external_memory> 段逐槽位标注）', allText.includes('<external_memory>') && allText.includes('[槽位 1_memory]') && allText.includes('两人在酒馆发生过争执'));
    const injectedExtTrace = result.trace.find(t => t.moduleId === 'inject_external_slot');
    check('外部槽位 trace 注记到槽位粒度', injectedExtTrace?.injected === true && injectedExtTrace.note.includes('1_memory'), `note=${injectedExtTrace?.note ?? '（无 trace）'}`);
    check('占位符替换（{{user}}/{{char}}/{{count}}）', !allText.includes('{{user}}') && !allText.includes('{{char}}') && !allText.includes('{{count}}') && allText.includes('王玉') && allText.includes('林霜'));
    // G2 视角口径：规则/few-shot/指令三层全部第三人称混合视角
    check('写作规则含三种推进视角（用户行动/角色主动/场景事件）', allText.includes('场景层面的事件发展') && allText.includes('主动行为或反应'));
    check('第三人称硬约束在场（用角色名或他／她）', allText.includes('第三人称') && allText.includes('不用「你」'));
    check('旧用户视角措辞清零', !allText.includes('以用户视角写') && !allText.includes('只写'));
    check('few-shot 旧三条仍在（反客为主/骤然断电）', allText.includes('反客为主') && allText.includes('骤然断电'));
    // m03359 整合轮：few-shot 3→7 条（真人反应类型覆盖）
    const fewShot = config.modules.find(m => m.id === 'few_shot');
    const fewShotCount = fewShot && fewShot.kind === 'text' ? (fewShot.content.match(/"title":/g) ?? []).length : 0;
    check('few-shot 扩为 7 条真人反应示例（岔开/回避/反将一军/幽默化解等）', fewShotCount === 7, `条数=${fewShotCount}`);
    check('生成指令口径＝下一步的行动选项/可选的推进方向（task 与指令去重后）', allText.includes('下一步的行动选项') && allText.includes('可选的推进方向') && !allText.includes('为当前剧情提供'));
    check('任务指令收尾为 user 角色', result.messages[result.messages.length - 1]?.role === 'user');
    check('trace 全模块覆盖', result.trace.length === config.modules.length);

    // 外部槽位注入单步链路已由上方「勾选即生效」覆盖；再验证模块级
    // 启停开关的优先权：关掉 external 模块后即便 sources 供给也不注入
    const modulesOff = config.modules.map(m => (m.id === 'inject_external_slot' ? { ...m, enabled: false } : m));
    const offResult = assembleMessages(modulesOff, sources);
    const extTrace = offResult.trace.find(t => t.moduleId === 'inject_external_slot');
    check('模块开关优先（关掉后不注入）', extTrace?.injected === false, `note=${extTrace?.note ?? '（无 trace）'}`);

    const traceText = renderTraceCompact(result);
    console.info(`[choice-smoke] trace: ${traceText}`);
    return renderDump(result);
}

/** 解析回退确定性触发机判（批B 判据）。 */
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
}

/**
 * G3 思考强度机判：buildGenerateBody 的 reasoning_effort 字段纪律
 * （非 off 才发送；off/缺省不出现该键——默认行为与加字段前逐字节一致）。
 */
function runReasoningEffortChecks(): void {
    const messages = [{ role: 'user' as const, content: 'x' }];
    const base = {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        stream: true,
        outputContract: 'prompt_only' as const,
    };
    const withHigh = buildGenerateBody(messages, { ...base, reasoningEffort: 'high' });
    check('reasoningEffort 非 off 时发送 reasoning_effort', (withHigh as Record<string, unknown>).reasoning_effort === 'high', `body=${JSON.stringify(withHigh)}`);
    const withOff = buildGenerateBody(messages, { ...base, reasoningEffort: 'off' });
    check('reasoningEffort off 时不发送该字段', !('reasoning_effort' in withOff), `body=${JSON.stringify(withOff)}`);
}

/**
 * debugForceRaw 调试开关机判（批B 判据：生成管线接线）。
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

/** 冒烟入口（main.ts node 分支调用；返回失败清单长度供收口）。 */
export async function runChoiceSmoke(): Promise<void> {
    console.info('=== choice 组装/解析机判（批B）===');
    const dumpText = runAssemblyChecks();
    console.info('=== 组装 dump 全文 ===');
    console.info(dumpText);
    runParseChecks();
    runReasoningEffortChecks();
    await runDebugForceRawChecks();
    console.info('=== choice 池抽取/asset 同步/导入/注入/绑定/自动生成机判（批C/C.2）===');
    runPoolChecks();
    runAssetPoolChecks();
    runImportRoundTrip();
    runInjectionChecks();
    runBindingCascadeChecks();
    await runAutoGenerateChecks();
    if (failures.length > 0) {
        console.error(`[choice-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[choice-smoke] OK：组装注入逐项可见、占位符替换、trace 覆盖、解析回退确定性触发、debugForceRaw 生成管线接线全部通过；池抽取分布/数学、asset 同步（110 条/17 分类/首次翻转/幂等不回翻/污染恢复）、旧数据导入往返＋幂等、池注入分区与分层、绑定级联、MESSAGE_RECEIVED 守卫链全部通过。');
}
