/**
 * node 冒烟的 persona 机判部分：迁移幂等＋统一端点收编＋五任务
 * 提示词引擎＋api 客户端形状＋store 互斥＋人设写回渲染通道。
 *
 * 设计：与 choice/smoke.ts 同构（check() 打 [persona-smoke] PASS/FAIL 行，
 * scripts/smoke.mjs 收口断言）。全部走合成数据——不依赖宿主在场数据，
 * 断言确定性；与浏览器真实数据共用同一条 storage/generation 代码路径
 * （dist 加载即覆盖）。
 */
import { event_types, extension_settings, getCurrentCharacter, getTavernContext, readPresetInjectMessages, upsertPersona } from '@/host';
import { toolkitGlobalPort } from '@/global-port';
import { getChat, getGlobal, setChat, setGlobal } from '@/storage/service';
import type { ChatDomain } from '@/storage/service';
import { migratePersonaDomain, readPersonaDomain, writePersonaDomain, LEGACY_KEYS, RETIRED_KEYS } from './storage';
import { DEFAULT_TEMPLATES } from './prompts';
import { isSchemaSkeleton, parseYamlToBlocks } from './yaml';
import { normalizeApiBase, normalizeApiUrl, buildGenerateBody, callGenerateEndpoint } from '@/modules/apis/client';
import { useRunlogStore } from '@/modules/runlog/store';
import { migrateApiDomain, migrateTaskProfiles } from '@/modules/apis/migration';
import { deleteEndpoint, readApiDomain, setProviderNoPrefill, writeApiDomain, writeJailbreakPreset } from '@/modules/apis/storage';
import { readTaskProfiles, writeTaskProfiles, type TaskProfilesDomain } from '@/modules/apis/task-profiles';
import { TASK_IDS } from '@/tasks';
import { DEFAULTS_VERSION, TASK_KEYS, createTaskDefaultConfig, ensurePromptConfigs, usePromptsStore, assembleMessages, GLOBAL_PROMPT_CONFIGS_KEY, type PersonaAssemblySources } from '@/prompts';
import { runGeneration, stripYamlFence, collectWorldInfoContext } from './generation';
import { usePersonaStore } from './store';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
    console.info(`[persona-smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

/** localStorage 存根访问（smoke.mjs 提供 Map 形态）。 */
const ls = {
    get(key: string): string | null {
        return globalThis.localStorage?.getItem(key) ?? null;
    },
    set(key: string, value: string): void {
        globalThis.localStorage?.setItem(key, value);
    },
    remove(key: string): void {
        globalThis.localStorage?.removeItem(key);
    },
};

/** 抹掉 persona 域（直接动存根单例，模拟「域缺席」首启动）。 */
function wipeDomain(): void {
    const tt = extension_settings.ttToolkit as Record<string, unknown> | undefined;
    if (tt) delete tt.persona;
}

/** 统一服务商表＋choice 域＋任务档案域整体抹掉（收编场景需要三域从零起步）。 */
function wipeApiScenarioDomains(): void {
    const tt = extension_settings.ttToolkit as Record<string, unknown> | undefined;
    if (tt) {
        delete tt.apis;
        delete tt.choice;
        delete tt.persona;
        delete tt.taskProfiles;
        delete tt.activeEndpointId;
    }
}

/** 全任务档案统一种子（全部指向同一服务商＋模型——迁移保真与 e2e 前置共用）。 */
function seedTaskProfiles(providerId: string, model: string): void {
    const profiles = {} as TaskProfilesDomain;
    for (const id of TASK_IDS) profiles[id] = { providerId, model };
    writeTaskProfiles(profiles);
}

function domainJson(): string {
    return JSON.stringify(readPersonaDomain());
}

/** 原始域形状（未经 normalize 的存根直读——过渡字段断言必须走这里）。 */
function rawPersona(): Record<string, unknown> {
    const tt = extension_settings.ttToolkit as Record<string, unknown> | undefined;
    return (tt?.persona ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1) 迁移幂等（空 localStorage→写域；旧键→搬入；统一端点收编；二次零重写）
// ---------------------------------------------------------------------------

function runMigrationChecks(): void {
    // 清场：域+全部旧键+退休键
    wipeDomain();
    for (const key of Object.values(LEGACY_KEYS)) ls.remove(key);
    for (const key of RETIRED_KEYS) ls.remove(key);

    // 1a. 空 localStorage → 写默认域
    const first = migratePersonaDomain();
    const defaults = readPersonaDomain();
    check('迁移：空 localStorage 首启动写入默认域（只剩 userContext）',
        !first.skipped && first.migratedKeys.length === 0
        && !('uiState' in (defaults as unknown as Record<string, unknown>))
        && defaults.userContext.request === '' && defaults.userContext.result === '',
        `skipped=${first.skipped} migrated=${first.migratedKeys.join(',') || '无'}`);

    // 1b. 预置 3 旧键 + 1 退休键 → 域缺席 → 搬入
    const legacyState = {
        localConfig: {
            apiSource: 'independent',
            indepApiUrl: 'https://relay.example.com/v1',
            indepApiKey: 'sk-legacy',
            indepApiModel: 'deepseek-chat',
            indepTimeout: 600,
            indepStream: false,
            thinkingEffort: 'high',
            // 注意：无 apiProfiles（触发收档迁移「默认配置 1」）
        },
    };
    ls.set(LEGACY_KEYS.state, JSON.stringify(legacyState));
    ls.set(LEGACY_KEYS.uiState, JSON.stringify({ generationPreset: 'Pure' }));
    ls.set(LEGACY_KEYS.dataUser, JSON.stringify({ request: '写个侦探', result: '姓名: 阿德', hasResult: true, template: '旧字段应被丢弃' }));
    ls.set('pw_template_v6_new_yaml', '旧退休键残留');
    wipeDomain();

    const second = migratePersonaDomain();
    const migrated = readPersonaDomain();
    check('迁移：2 旧键搬入（uiState 键退役不读——快照留存）',
        second.migratedKeys.length === 2
        && LEGACY_KEYS.state && second.migratedKeys.includes(LEGACY_KEYS.state)
        && !second.migratedKeys.includes(LEGACY_KEYS.uiState)
        && second.migratedKeys.includes(LEGACY_KEYS.dataUser),
        `migrated=${second.migratedKeys.join(',')}`);
    // 过渡透传已随 localConfig 域退役换形：端点旧字段不再进域，收编原料
    // 由 apis/migration 直接读 legacy 快照键（此处断言域新形状＋快照原样
    // 保留——「只读不写」纪律的读侧证明）
    check('迁移：localConfig 键不进域（任务参数固化；端点旧字段走 legacy 快照）',
        !('localConfig' in rawPersona())
        && ls.get(LEGACY_KEYS.state)?.includes('indepApiUrl') === true);
    check('迁移：userContext 形状正确＋uiState 键不进域（任务级预设选择退役）',
        !('uiState' in (migrated as unknown as Record<string, unknown>))
        && migrated.userContext.request === '写个侦探' && migrated.userContext.result === '姓名: 阿德'
        && !('template' in (migrated.userContext as unknown as Record<string, unknown>))
        && !('hasResult' in (migrated.userContext as unknown as Record<string, unknown>))
        && ls.get(LEGACY_KEYS.uiState) !== null);
    check('迁移：域形状收缩（wiSelection/pinnedBooks/extraBooks 不再是域字段）',
        !('wiSelection' in (migrated as unknown as Record<string, unknown>))
        && !('pinnedBooks' in (migrated as unknown as Record<string, unknown>)));
    // v1.1.0 存量域（含世界书勾选/钉选字段＋v1.3/v1.4 的 localConfig 旧键）
    // 导入：normalize 丢弃退役字段，其余字段逐项保真——判据「迁移数据未受损」
    // 的读侧证明
    wipeDomain();
    (extension_settings.ttToolkit as Record<string, unknown>).persona = {
        localConfig: { stream: true, thinkingEffort: 'off', timeoutSec: 300, endpointId: 'v1.3旧引用', extraBooks: ['v1.1.0追加书'] },
        wiSelection: { charA: { '旧书': ['1', '2'] } },
        pinnedBooks: ['v1.1.0钉选书'],
        uiState: { generationPreset: 'pure' },
        userContext: { request: 'v1.1.0现场', result: '姓名: 旧人设' },
    };
    const upgraded = readPersonaDomain();
    check('迁移：v1.1.0 存量域导入（退役字段丢弃、其余字段逐项相等）',
        !('uiState' in (upgraded as unknown as Record<string, unknown>))
        && upgraded.userContext.request === 'v1.1.0现场' && upgraded.userContext.result === '姓名: 旧人设'
        && !('wiSelection' in (upgraded as unknown as Record<string, unknown>))
        && !('pinnedBooks' in (upgraded as unknown as Record<string, unknown>))
        && !('localConfig' in (upgraded as unknown as Record<string, unknown>)));
    check('迁移：退休键 removeItem 清理（pw_template_v6_new_yaml）',
        second.retiredKeysCleaned.includes('pw_template_v6_new_yaml') && ls.get('pw_template_v6_new_yaml') === null);
    check('迁移：旧键保留作 legacy 快照（防回滚丢增量）',
        ls.get(LEGACY_KEYS.state) !== null && ls.get(LEGACY_KEYS.dataUser) !== null);

    // 1e. 统一端点收编场景（choice 旧 apis[]＋persona 配置档撞 id/去重）
    // —— 三域全部从零起步，模拟旧版存档升级到统一端点表的一次性迁移
    for (const key of Object.values(LEGACY_KEYS)) ls.remove(key);
    wipeApiScenarioDomains();
    const tt = extension_settings.ttToolkit as Record<string, unknown>;
    tt.choice = {
        apis: [
            { id: 'c1', name: 'choice端点一', apiurl: 'https://choice.example.com/v1', key: 'sk-c1', model: 'm-choice', stream: false, temperature: 0.3, max_tokens: 777, outputContract: 'json_schema' },
            { id: 'c2', name: 'choice端点二', apiurl: 'https://choice-two.example.com/v1', key: 'sk-c2', model: 'm-choice-2', stream: true, temperature: 0.9, max_tokens: 1024 },
        ],
        activeApiId: 'c2',
        gen: { count: 5, contextRounds: 2, minChars: 5, maxChars: 50, clickBehavior: 'append', debugForceRaw: false },
        pool: { masterPool: [] },
    };
    // 预置一条已经学到能力的统一表条目（回滚旧版再升级的现场：收编会逐字段
    // 重建整表，写口又绕开读侧归一——漏带 noPrefill ＝ 每跑一次抹回 false）。
    // 直写原始域（writeApiDomain 会按读侧口径归一，测不到写口真实行为）。
    tt.apis = [
        { id: 'pre-learned', name: '预置服务商', url: 'https://pre.example.com/v1', key: 'sk-pre', models: ['m-pre'], model: 'm-pre', noPrefill: true },
    ];
    ls.set(LEGACY_KEYS.state, JSON.stringify({
        localConfig: {
            apiSource: 'independent',
            indepApiUrl: 'https://custom.example.com/v1',
            indepApiKey: 'sk-custom',
            indepApiModel: 'gpt-custom',
            indepTimeout: 90,
            indepStream: true,
            thinkingEffort: 'medium',
            apiProfiles: [
                // id 'c2' 与 choice 侧撞车且端点不同 → 收编时重分配新 id
                { id: 'c2', name: '撞车档', url: 'https://persona.example.net/v1', key: 'sk-p', model: 'm-persona' },
                // url+model 与 choice c1 相同 → 去重并入（id 映射到 c1）
                { id: 'p-dup', name: '重复档', url: 'https://choice.example.com/v1', key: 'sk-p2', model: 'm-choice' },
            ],
            activeApiProfileId: 'p-dup',
        },
    }));
    migratePersonaDomain();
    const report = migrateApiDomain();
    const tpReport = migrateTaskProfiles();
    const endpoints = readApiDomain();
    const c1 = endpoints.find(e => e.id === 'c1');
    const c2 = endpoints.find(e => e.id === 'c2');
    const remapped = endpoints.find(e => e.name === '撞车档');
    check('收编：choice 旧 apis 并入统一表（id 保留、字段零丢失）',
        !report.skipped && report.collectedFrom.includes('choice') && report.endpointCount === 4
        && !!c1 && c1.name === 'choice端点一' && c1.url === 'https://choice.example.com/v1' && c1.key === 'sk-c1'
        && !!c2 && c2.url === 'https://choice-two.example.com/v1' && c2.key === 'sk-c2');
    check('收编：persona 侧撞 id 重分配＋同端点去重（idRemaps/mergedDuplicates）',
        report.mergedDuplicates === 1
        && report.idRemaps.length === 1 && report.idRemaps[0].from === 'c2' && typeof report.idRemaps[0].to === 'string'
        && !!remapped && remapped.id !== 'c2',
        `remaps=${JSON.stringify(report.idRemaps)} merged=${report.mergedDuplicates}`);
    const rawChoice = (tt.choice ?? {}) as Record<string, unknown>;
    check('收编：choice 域 v2 重写（产物 {gen,pool} 无 task 键）',
        !('task' in rawChoice)
        && ((rawChoice.gen ?? {}) as Record<string, unknown>).count === 5
        && Array.isArray(((rawChoice.pool ?? {}) as Record<string, unknown>).masterPool)
        && !('apis' in rawChoice) && !('activeApiId' in rawChoice),
        `choice=${JSON.stringify(rawChoice)}`);
    // 任务档案化迁移（v1.9 通道二）：旧活动键 c2 命中条目 → 任务档案收编
    // {c2, m-choice-2}；apis 条目 model 字段删除；activeEndpointId 键退役
    const ttRaw = extension_settings.ttToolkit as Record<string, unknown>;
    const rawApisAfter = Array.isArray(ttRaw.apis) ? (ttRaw.apis as Array<Record<string, unknown>>) : [];
    const profilesAfter = (ttRaw.taskProfiles ?? {}) as Record<string, { providerId?: unknown; model?: unknown }>;
    check('任务档案迁移：全部任务行初始化为旧活动端点 {c2, m-choice-2}',
        !tpReport.skipped && tpReport.initializedFrom === 'activeEndpoint' && tpReport.providerized >= 3
        && TASK_IDS.every(id => profilesAfter[id]?.providerId === 'c2' && profilesAfter[id]?.model === 'm-choice-2'),
        `report=${JSON.stringify(tpReport)} profiles=${JSON.stringify(profilesAfter)}`);
    check('任务档案迁移：apis 条目 model 字段收编后删除、activeEndpointId 键不在',
        rawApisAfter.length === 4 && rawApisAfter.every(e => !('model' in e))
        && !('activeEndpointId' in ttRaw));
    check('收编：既有统一表条目的端点能力记忆随收编保留（不回退成 false）',
        readApiDomain().find(e => e.id === 'pre-learned')?.noPrefill === true,
        `entry=${JSON.stringify(readApiDomain().find(e => e.id === 'pre-learned'))}`);
    const afterCollect = readPersonaDomain();
    check('收编：persona 域 v2 重写（整键清洗后无 localConfig/uiState 键；选中不参与提升——choice 优先）',
        !('localConfig' in (afterCollect as unknown as Record<string, unknown>))
        && !('localConfig' in rawPersona())
        && !('uiState' in (afterCollect as unknown as Record<string, unknown>)));

    // 1f. 二次启动零重写（统一表＋档案域在场 → 三通道全部 skip，逐字节不变）
    const apisBefore = JSON.stringify(tt.apis);
    const choiceBefore = JSON.stringify(tt.choice);
    const personaBefore = domainJson();
    const personaSecond = migratePersonaDomain();
    const apisSecond = migrateApiDomain();
    const tpSecond = migrateTaskProfiles();
    check('收编：二次启动零重写（三步迁移均 skip、三域逐字节不变）',
        personaSecond.skipped && apisSecond.skipped && tpSecond.skipped
        && JSON.stringify(tt.apis) === apisBefore
        && JSON.stringify(tt.choice) === choiceBefore
        && domainJson() === personaBefore);

    // 1h. 删被档案引用的服务商 → 引用任务行联动重置（回未配置态）
    writeApiDomain([{ id: 'smoke-del', name: '待删服务商', url: 'https://del.example.com/v1', key: 'k', models: ['m-del'], noPrefill: false }]);
    seedTaskProfiles('smoke-del', 'm-del');
    deleteEndpoint('smoke-del');
    const profilesAfterDelete = readTaskProfiles();
    check('服务商删除：被档案引用时引用任务行联动重置（回未配置态、条目出表）',
        TASK_IDS.every(id => profilesAfterDelete[id].providerId === '' && profilesAfterDelete[id].model === '')
        && readApiDomain().every(e => e.id !== 'smoke-del'));

    // 1g. 退休键清理无条件（域在场也清）——再放回验证
    ls.set('pw_custom_themes_v1', '残留');
    const fourth = migratePersonaDomain();
    check('迁移：域在场时退休键清理仍执行（pw_custom_themes_v1）',
        fourth.skipped && fourth.retiredKeysCleaned.includes('pw_custom_themes_v1') && ls.get('pw_custom_themes_v1') === null);

    // 清场还原默认域（后续分区读域不依赖本段合成数据）
    for (const key of Object.values(LEGACY_KEYS)) ls.remove(key);
    wipeApiScenarioDomains();
    migratePersonaDomain();
}

// ---------------------------------------------------------------------------
// 2) 全任务提示词引擎（存储形态＋默认模板＋任务键）
// ---------------------------------------------------------------------------

function runPromptsChecks(): void {
    const prompts = usePromptsStore();
    const raw = getGlobal(GLOBAL_PROMPT_CONFIGS_KEY) as unknown;
    const record = (raw ?? {}) as Record<string, unknown>;
    const choiceModules = (record.choice as { modules?: unknown[] } | undefined)?.modules;
    check('prompts：全任务键 Record 齐备（choice 18 模块回归红线）',
        !Array.isArray(raw) && typeof raw === 'object' && raw !== null
        && TASK_KEYS.every(k => record[k] !== undefined)
        && Array.isArray(choiceModules) && choiceModules.length === 18
        && prompts.configFor('persona_curator') !== null
        && prompts.configFor('persona_gen') !== null,
        `keys=${Object.keys(record).join('/')}`);

    // 旧档（单元素数组）→ Record 一次性迁移：choice id 保留＋补缺席键。
    // 迁移写在启动 init（ensurePromptConfigs——读路径零副作用后的唯一
    // 落盘口），模拟「旧档在场」的启动即调 init
    const legacySet = { id: 'legacy-set', name: '旧套', modules: [{ kind: 'text', id: 't1', name: '文本', role: 'user', order: 10, content: '旧指令', enabled: true }] };
    setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, [legacySet]);
    ensurePromptConfigs();
    // 外部直写域后必须打失效信号（revision++）——读透传 getter 只跟踪
    // revision，否则返回首次调用的缓存快照看不到外部写
    prompts.$patch({ revision: prompts.revision + 1 });
    const migratedChoice = prompts.configFor('choice');
    const rawAfter = getGlobal(GLOBAL_PROMPT_CONFIGS_KEY) as unknown;
    check('prompts：旧数组形态一次写迁移（choice id 保留、补缺 persona 两键）',
        migratedChoice?.id === 'legacy-set' && !Array.isArray(rawAfter) && rawAfter !== null
        && (rawAfter as Record<string, unknown>).persona_gen !== undefined);
    // 还原 choice 18 模块红线（恢复默认＝smoke 直调写通道，store 无编辑面 action）
    const restored = getGlobal(GLOBAL_PROMPT_CONFIGS_KEY) as Record<string, unknown>;
    setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, { ...restored, choice: createTaskDefaultConfig('choice') });
    // 直写域后打失效信号（与上方旧档写同款纪律——后续 configFor 断言读新值）
    prompts.$patch({ revision: prompts.revision + 1 });

    // 默认配置版本化重建：版本落后的默认快照（defaultsVersion 落后于当前
    // ——真实升级存量的形态）启动后被整键重建为新版并盖新版本号
    // （id!=='default' 的定制键不覆盖——防御分支）
    const withStale = getGlobal(GLOBAL_PROMPT_CONFIGS_KEY) as Record<string, unknown>;
    setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, {
        ...withStale,
        persona_gen: { id: 'default', name: '默认', defaultsVersion: DEFAULTS_VERSION - 1, modules: [] },
    });
    ensurePromptConfigs();
    prompts.$patch({ revision: prompts.revision + 1 });
    const afterRebuild = getGlobal(GLOBAL_PROMPT_CONFIGS_KEY) as Record<string, { id?: string; defaultsVersion?: number; modules?: unknown[] }>;
    check('prompts：旧默认快照版本化重建（整键重建＋版本号写入）',
        afterRebuild.persona_gen?.id === 'default'
        && afterRebuild.persona_gen?.defaultsVersion === DEFAULTS_VERSION
        && Array.isArray(afterRebuild.persona_gen?.modules) && afterRebuild.persona_gen.modules.length === 2);

    const curatorConfig = prompts.configFor('persona_curator');
    const genConfig = prompts.configFor('persona_gen');
    const curatorText = (curatorConfig?.modules.find(m => m.kind === 'text')?.content ?? '');
    const genText = (genConfig?.modules.find(m => m.kind === 'text')?.content ?? '');
    check('prompts：curator 默认模板占位符（{{charInfo}}/{{userRequirements}}）',
        curatorText.includes('{{charInfo}}') && curatorText.includes('{{userRequirements}}'));
    check('prompts：persona_gen 默认模板占位符（{{charInfo}}/{{greetings}}/{{template}}/{{input}}）',
        genText.includes('{{charInfo}}')
        && genText.includes('{{greetings}}') && genText.includes('{{template}}')
        && genText.includes('{{input}}'));

    const templateBlocks = parseYamlToBlocks(DEFAULT_TEMPLATES.user);
    const keys = [...templateBlocks.keys()];
    check('prompts：默认用户人设模板十二块（基本信息/外貌/性格/情绪光谱/自我认知/恐惧软肋/言谈习惯/喜恶/底线雷区/技能专长/前史/目标动机）',
        keys.length === 12 && ['基本信息', '外貌', '性格', '情绪光谱', '自我认知', '恐惧软肋', '言谈习惯', '喜恶', '底线雷区', '技能专长', '前史', '目标动机'].every(k => keys.includes(k)),
        `blocks=${keys.join('/')}`);

    // 骨架双源机判：回退骨架（DEFAULT_TEMPLATES.user）的性格叶键名与
    // 策展清单 <reference_modules> 性格行声明一致——两侧集合对称相等
    // （单向包含＋手抄叶数组都会漏改静默通过：换叶同数时长度不变、检测器
    // 自身的数组忘了同步时断言恒真），改任一侧漏改另一侧即翻红
    const personaLeaves = (templateBlocks.get('性格') ?? '')
        .split('\n').map(l => l.trim().replace(/:$/, '')).filter(Boolean);
    const curatorLine = curatorText.split('\n').find(l => l.startsWith('性格——')) ?? '';
    const curatorLeaves = (curatorLine.split('；')[0]?.split('——')[1] ?? '')
        .split('/').map(s => s.trim()).filter(Boolean);
    const leavesAligned = personaLeaves.length === curatorLeaves.length
        && personaLeaves.every(k => curatorLeaves.includes(k));
    check('prompts：骨架双源机判（回退骨架性格叶＝策展清单性格行声明，集合对称相等）',
        curatorLine !== '' && leavesAligned,
        `骨架叶=${personaLeaves.join('/')} 清单叶=${curatorLeaves.join('/')}`);

    // 清单体量机判：行同时含「——」与「；」＝清单行形态（段标签与空行
    // 不计）——55 行是策展清单扩容后的固定体量，漏行/多行即翻红
    const refModuleText = curatorText.split('<reference_modules>')[1]?.split('</reference_modules>')[0] ?? '';
    const refLineCount = refModuleText.split('\n').filter(l => l.includes('——') && l.includes('；')).length;
    check('prompts：curator 参考清单体量（55 行）', refLineCount === 55, `lines=${refLineCount}`);
    check('prompts：机制挂载开放段在场',
        curatorText.includes('<mechanism_mounts>') && curatorText.includes('示例之外出现任何机制同样挂载'));
    check('prompts：新口径生效（上限 16＋元层剥离）',
        curatorText.includes('上限 16') && !curatorText.includes('扮演红线') && !curatorText.includes('呈现偏好'));
    check('prompts：gen 值厚度与行为心理类传导',
        genText.includes('≤40 个汉字') && genText.includes('长度上限 40 个汉字') && genText.includes('行为心理类')
        && !genText.includes('≤20 个汉字') && !genText.includes('长度上限 30 个汉字'));
}

// ---------------------------------------------------------------------------
// 3) persona 任务组装管线（引擎多任务化——choice 路径零行为变化红线在
//    choice/smoke.ts 的 90 条断言）
// ---------------------------------------------------------------------------

const assemblySources: PersonaAssemblySources = {
    wiText: '> [FILE: 设定书]\n"""\n魔法世界\n"""',
    charInfo: '林霜，温柔',
    greetings: '「你好，旅行者」',
    userRequest: '写个侦探',
    curatedSchema: '基本信息:\n姓名:\n年龄:',
    userName: '王玉',
    charName: '林霜',
};

function runPersonaAssemblyChecks(): void {
    const prompts = usePromptsStore();

    // curator 管线：wi 一条 system（任务级预设源已退役——预设影响走传输层
    // 破限注入，不进引擎），user 指令占位符清零
    const curator = assembleMessages(prompts.configFor('persona_curator')?.modules ?? [], assemblySources);
    check('persona 组装：curator 管线（wi system＋user 指令、占位符清零、无预设段）',
        curator.messages.length === 2
        && curator.messages[0].role === 'system'
        && curator.messages[0].content.includes('魔法世界') && !curator.messages[0].content.includes('你是人设生成器')
        && curator.messages[1].role === 'user'
        && curator.messages[1].content.includes('林霜，温柔') && curator.messages[1].content.includes('写个侦探')
        && !curator.messages[1].content.includes('{{charInfo}}') && !curator.messages[1].content.includes('{{userRequirements}}'));

    // gen 管线：{{template}}←策展 schema、{{greetings}}、{{input}} 全填；
    // 指令层无 {{user}} 宏——User 锚定行直接进正文
    const gen = assembleMessages(prompts.configFor('persona_gen')?.modules ?? [], assemblySources);
    const genUser = gen.messages[gen.messages.length - 1].content;
    check('persona 组装：persona_gen 管线（占位符全部填充＋User 锚定行在场）',
        gen.messages.length === 2 && gen.messages[1].role === 'user'
        && genUser.includes('User——使用者本人的扮演身份') && genUser.includes('林霜，温柔')
        && genUser.includes('「你好，旅行者」') && genUser.includes('基本信息:\n姓名:\n年龄:')
        && genUser.includes('写个侦探') && !genUser.includes('{{'));

    // 模块开关闭环：关指令模块→user 消失 trace 留痕；开回→恢复。
    // 提示词编辑面已删（toggleModule action 同删）——
    // 改本地数组改造（choice smoke modulesOff 同款；modules[].enabled
    // 字段保留、引擎照读的实证）
    const genModules = prompts.configFor('persona_gen')?.modules ?? [];
    const offModules = genModules.map(m => (m.id === 'persona_gen_prompt' ? { ...m, enabled: false } : m));
    const off = assembleMessages(offModules, assemblySources);
    const offTrace = off.trace.find(t => t.moduleId === 'persona_gen_prompt');
    const offOk = off.messages.length === 1 && off.messages[0].role === 'system' && offTrace?.note === '模块已停用';
    const on = assembleMessages(genModules, assemblySources);
    check('persona 组装：模块开关闭环（停用留痕不注入、启用恢复注入）',
        offOk && on.messages.length === 2 && on.messages[1].role === 'user');
}

/** dump 观测口断言（异步——__TT_TOOLKIT__.prompts.dump 按任务返回全文）。 */
async function runPersonaAssemblyDumpChecks(): Promise<void> {
    const port = (toolkitGlobalPort().prompts as { dump: (task?: string) => Promise<string> } | undefined);
    const dumpText = await (port ? port.dump('persona_gen') : Promise.reject(new Error('口缺席')));
    check('dump 口：按任务 dump 全文（persona_gen：组装 dump 标头＋模块清单＋指令正文）',
        dumpText.includes('=== 消息组装 dump') && dumpText.includes('生成指令')
        && dumpText.includes('[任务：生成用户人设]'));
    // 观测面口径：dump 的消息段含传输层破限前缀段——
    // 冒烟桩未选预设 → 标注「无传输层前缀」；选中预设的场景由 stub 破限
    // 断言覆盖（jb 前缀进消息序列 = 同一 composeOutbound 实现）
    check('dump 口：观测口径标注传输层前缀状态（未选预设＝无传输层前缀）',
        dumpText.includes('消息数组（') && dumpText.includes('无传输层前缀'));
    let thrownUnknown = false;
    try {
        await port?.dump('bogus');
    } catch (e) {
        thrownUnknown = (e as Error).message.includes('未知任务键');
    }
    check('dump 口：未知任务键 fail fast（提示可选值）', thrownUnknown);
}

// ---------------------------------------------------------------------------
// 4) yaml 纯函数行为
// ---------------------------------------------------------------------------

function runPureFunctionChecks(): void {
    // 多顶层键分块
    const blocks = parseYamlToBlocks('基本信息:\n  姓名: 测试\n外貌:\n  概貌: 高个\n');
    check('yaml：多顶层键分块（键集合与内联缩进值）',
        blocks.size === 2 && (blocks.get('基本信息')?.includes('姓名: 测试') ?? false) && (blocks.get('外貌')?.includes('概貌: 高个') ?? false));

    // 剥围栏
    check('yaml：```yaml 围栏剥除',
        parseYamlToBlocks('```yaml\n姓名: 测试\n```').get('姓名') !== undefined);

    // 单顶层键嵌套（模型把全部子块缩进在唯一顶层键下）→ 余行去缩进后
    // 子键提升为顶层键（旧 fork 契约：唯一顶层键本身被丢弃）
    const nested = parseYamlToBlocks('基本信息:\n  姓名: 测试\n  年龄: 20\n');
    const nestedKeys = [...nested.keys()];
    check('yaml：单顶层键误嵌套修复（余行去缩进、子键提升为顶层键）',
        nestedKeys.includes('姓名') && nestedKeys.includes('年龄')
        && (nested.get('姓名') ?? '').includes('测试') && (nested.get('年龄') ?? '').includes('20'),
        `keys=${nestedKeys.join('/')}`);

    // stripYamlFence：围栏提取 + prefill 补回判定
    check('stripYamlFence：围栏内提取 trim',
        stripYamlFence('```yaml\n姓名: 测试\n```') === '姓名: 测试');
    check('stripYamlFence：prefill 未闭合（首行 姓名:）补 prefill 再剥',
        stripYamlFence('姓名: 测试\n年龄: 20', '```yaml\n基本信息:') === '基本信息:姓名: 测试\n年龄: 20'
        || stripYamlFence('姓名: 测试\n年龄: 20', '```yaml\n') === '姓名: 测试\n年龄: 20');

    // isSchemaSkeleton：策展产出的可用性判据。事故原型——宿主错误正文里
    // 「连接目标服务失败：」「请求地址: …」都是合法的「键行」形态，旧判据
    // （切得出顶层键即合法）把它判成可用 schema 送进第二段。新判据要求
    // 每一行都是键/缩进内容/列表项，顶格散文出局。
    check('yaml：骨架判据放行真骨架（含缩进叶与围栏）',
        isSchemaSkeleton('```yaml\n基本信息:\n  年龄:\n  性别:\n外貌:\n  整体印象:\n```')
        && isSchemaSkeleton(DEFAULT_TEMPLATES.user));
    check('yaml：骨架判据拦下宿主错误正文（顶格散文行出局）',
        !isSchemaSkeleton('[API 错误]\n连接目标服务失败：当前网络、VPN、代理或接口地址可能暂时不可用。\n\n请检查网络连接、VPN、代理或自定义接口地址，然后重试。\n\n请求地址: https://api.commandcode.ai/provider/v1/chat/completions'));
    check('yaml：骨架判据拦下空响应与纯散文',
        !isSchemaSkeleton('') && !isSchemaSkeleton('   \n\t ')
        && !isSchemaSkeleton('好的主人，您的骚母狗已经完全准备好了，请主人下达指令。'));
    // 换皮形态：散言前导（带子句标点的句子）被宽松键正则认成顶层键时，
    // 该键会被 profilePrefillFor 派生成第二段起手词＝把错误正文再送进去
    // 一次。严格键名（排除子句标点）＋顶层键 ≥2 双条件拦下它。
    check('yaml：骨架判据拦下散言前导+真骨架（换皮形态：prefill 首键不得落在散文句上）',
        !isSchemaSkeleton('好的，以下是为您定制的骨架：\n基本信息:\n  年龄:\n外貌:\n  整体印象:')
        && !isSchemaSkeleton('请求地址: https://api.example.com/v1')
        && !isSchemaSkeleton('基本信息:\n  年龄:\n  性别:'),  // 单顶层键不足（真骨架至少两块）
        '换皮形态与单键形态都应出局');
    // 校验与切块必须共用同一「块界」定义：1 空格缩进、键名带标点的行
    // 会被宽松切块当新顶层块，校验若把它当「缩进内容从宽」就出现
    // 「判据说这是骨架、切块给出的却不是这个形状」的分歧（双复核实锤）。
    // 该形态必须出局——它的块值会截断真骨架并多出空块进第二段注入。
    check('yaml：骨架判据与切块共用块界定义（1 空格缩进的散言行不得放行）',
        !isSchemaSkeleton('基本信息:\n 年龄:\n 备注，注意如下:\n外貌:\n  整体印象:'),
        '该行会被切块当顶层块，校验必须同判');
}

// ---------------------------------------------------------------------------
// 5) 统一 api 客户端请求体形状（fetch 桩）
// ---------------------------------------------------------------------------

function fakeSSEStream(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const queue = chunks.map(c => encoder.encode(c));
    return {
        ok: true,
        status: 200,
        body: {
            // 与宿主同构：ReadableStreamDefaultReader 带 cancel（被放弃的流由
            // 传输层显式关闭）——桩缺 cancel 会让那条路径在桩上抛 TypeError
            // 并盖掉原始错误，缺陷与误报两个方向都测不到
            getReader: () => ({
                read: async () => queue.length > 0 ? { done: false, value: queue.shift() } : { done: true },
                cancel: async () => undefined,
            }),
        },
    } as unknown as Response;
}

async function runApiChecks(): Promise<void> {
    // 纯函数：端点规范化
    check('api：normalizeApiBase 剥尾斜杠+/chat/completions（保留 /v1）',
        normalizeApiBase('https://api.example.com/v1/chat/completions/') === 'https://api.example.com/v1'
        && normalizeApiBase('https://api.example.com') === 'https://api.example.com');
    check('api：normalizeApiUrl 四步（剥 /chat/completions、裸域名补 /v1、剥尾斜杠）',
        normalizeApiUrl('https://api.example.com/v1/chat/completions') === 'https://api.example.com/v1'
        && normalizeApiUrl('https://api.example.com') === 'https://api.example.com/v1'
        && normalizeApiUrl('https://api.example.com/v1/') === 'https://api.example.com/v1');

    // 纯函数：请求体形状（缺省任务参数不进请求体——显式发送制）
    const body = buildGenerateBody(
        [{ role: 'user', content: 'hi' }],
        { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'm1', stream: false, outputContract: 'prompt_only', reasoningEffort: 'off' },
    );
    check('api：buildGenerateBody 基础形状（quiet/custom/reverse_proxy/proxy_password/tool_choice；缺省温度与 max_tokens 不发）',
        body.type === 'quiet' && body.chat_completion_source === 'custom'
        && body.reverse_proxy === 'https://api.example.com/v1' && body.proxy_password === 'sk-test'
        && body.model === 'm1' && Array.isArray(body.messages) && body.tool_choice === 'none'
        && body.stream === false
        && !('temperature' in body) && !('max_tokens' in body) && !('reasoning_effort' in body)
        && !('response_format' in body) && !('json_schema' in body));
    const bodyExplicit = buildGenerateBody(
        [{ role: 'user', content: 'hi' }],
        { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'm1', stream: true, outputContract: 'prompt_only', temperature: 0.5 },
    );
    check('api：buildGenerateBody 显式参数（temperature 进请求体、stream 恒发）',
        bodyExplicit.temperature === 0.5 && bodyExplicit.stream === true && !('max_tokens' in bodyExplicit));

    // 输出契约两档（json_schema 档已随生成通道收敛退役——choice 恒 json_object，
    // 宿主透传 response_format；prompt_only 不发契约键）
    const bodyJsonObject = buildGenerateBody(
        [{ role: 'user', content: 'hi' }],
        { task: 'persona', baseUrl: 'https://a.example.com', apiKey: 'k', model: 'm', stream: false, outputContract: 'json_object' },
    );
    check('api：输出契约两档（json_object→response_format；prompt_only 无契约键）',
        (bodyJsonObject.response_format as Record<string, unknown> | undefined)?.type === 'json_object'
        && !('json_schema' in bodyJsonObject));

    // 破限预设解析（宿主桩「冒烟破限」）：启用文本条目按原角色原顺序，
    // marker 占位与停用条目剔除
    const jbEntries = readPresetInjectMessages('冒烟破限');
    check('api：破限预设解析（启用文本条目角色保真，marker/停用剔除）',
        jbEntries !== null && jbEntries.length === 2
        && jbEntries[0].role === 'assistant' && jbEntries[0].content === '破限开场白'
        && jbEntries[1].role === 'user' && jbEntries[1].content === '破限接话',
        `jb=${JSON.stringify(jbEntries)}`);
    check('api：破限预设悬空名返回 null（fail-soft 判据）', readPresetInjectMessages('不存在预设') === null);

    // stub 同构机判：管理器经 getPresetManager('openai') 取得实例——双方法
    // 在同一实例上，且 getCompletionPresetByName 保留接收者调用返回的预设
    // 与 this.getPresetList() 清单里的对象同一（内部 this 互调链成立的
    // 结构判据；stub 若退化成箭头函数/解引用调用，此断言翻红）
    const pm = getTavernContext()?.getPresetManager?.('openai');
    const pmRec = pm && typeof pm === 'object' ? (pm as unknown as Record<string, unknown>) : null;
    const pmList = pmRec && typeof pmRec.getPresetList === 'function'
        ? (pmRec.getPresetList as (api: string) => { presets: unknown[]; preset_names: Record<string, number> })('openai')
        : null;
    const pmPreset = pmRec && typeof pmRec.getCompletionPresetByName === 'function'
        ? (pmRec.getCompletionPresetByName as (name: string) => unknown)('冒烟破限')
        : undefined;
    check('api：破限管理器 stub 同构（同一实例双方法，this 内部互调成立）',
        pmRec !== null
        && typeof pmRec.getCompletionPresetByName === 'function'
        && typeof pmRec.getPresetList === 'function'
        && pmList !== null && Array.isArray(pmList.presets)
        && pmPreset !== undefined && pmPreset === pmList.presets[pmList.preset_names['冒烟破限']],
        `pm=${JSON.stringify(pmPreset)} / list=${JSON.stringify(pmList)}`);
    check('api：破限管理器保留接收者按名取预设（解引用丢 this 在此翻红）',
        pmPreset !== null && typeof pmPreset === 'object'
        && Array.isArray((pmPreset as { prompts?: unknown[] }).prompts)
        && (pmPreset as { prompts: unknown[] }).prompts.length === 4);

    // reasoning_effort 纪律（off 不发已在基础形状断言——这里断言 high 发）
    const bodyEffort = buildGenerateBody(
        [{ role: 'user', content: 'hi' }],
        { task: 'persona', baseUrl: 'https://a.example.com', apiKey: 'k', model: 'm', stream: false, outputContract: 'prompt_only', reasoningEffort: 'high' },
    );
    check('api：reasoning_effort＝high 注入（low/medium/high 档）', bodyEffort.reasoning_effort === 'high');

    // SSE 帧状态机（经 callGenerateEndpoint 公共面）
    const originalFetch = globalThis.fetch;
    const sseCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        sseCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
        return fakeSSEStream(['data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: [DONE]\n\n']);
    }) as typeof fetch;
    try {
        const r1 = await callGenerateEndpoint(
            [{ role: 'user', content: 'hi' }],
            { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'm1', stream: true, outputContract: 'prompt_only' },
        );
        check('api：流式 SSE 帧状态机（\\n\\n 分帧、[DONE] 跳过、delta 拼接、走宿主路由）',
            r1.streamed && r1.content === '你' && sseCalls[0]?.url === '/api/backends/chat-completions/generate',
            `text=${r1.content}`);
        globalThis.fetch = (async () => fakeSSEStream(['data: {"choices":[{"delta":{"content":"甲"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"乙"}}]}'])) as typeof fetch;
        const r2 = await callGenerateEndpoint(
            [{ role: 'user', content: 'hi' }],
            { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'm1', stream: true, outputContract: 'prompt_only' },
        );
        check('api：流式 \\r\\n 归一＋尾帧无终止符补消费', r2.content === '甲乙', `text=${r2.content}`);

        // 截断显式报错回归：finish_reason=length 的流不得静默成功——报错指名
        // 真因（推理模型思维链吃预算把正文掐断的实测形态），且记录保留半截正文
        globalThis.fetch = (async () => fakeSSEStream([
            'data: {"choices":[{"delta":{"content":"{\\"options\\": ["}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"甲\\""}}]}\n\n',
            'data: {"choices":[{"delta":{"content":""},"finish_reason":"length"}]}\n\n',
            'data: [DONE]\n\n',
        ])) as typeof fetch;
        let truncationThrown = '';
        try {
            await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'm1', stream: true, outputContract: 'prompt_only' },
            );
        } catch (e) {
            truncationThrown = (e as Error).message;
        }
        const truncationRecord = useRunlogStore().records[useRunlogStore().records.length - 1];
        check('api：finish_reason=length 截断显式报错（指名 token 上限真因＋记录保留半截正文，不伪装成解析失败）',
            truncationThrown.includes('输出被截断') && truncationThrown.includes('token 上限')
            && !!truncationRecord && truncationRecord.ok === false
            && truncationRecord.responseText.includes('"title":"甲"') && (truncationRecord.error ?? '').includes('输出被截断'),
            `thrown=${truncationThrown.slice(0, 60)}`);
    } finally {
        globalThis.fetch = originalFetch;
    }

    // 非流式：content 读取 + json.error 抛错
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '好的' } }] }) })) as unknown as typeof fetch;
    try {
        const r3 = await callGenerateEndpoint(
            [{ role: 'user', content: 'hi' }],
            { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'm1', stream: false, outputContract: 'prompt_only' },
        );
        check('api：非流式 content 读取（choices[0].message.content）', !r3.streamed && r3.content === '好的');
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ error: { message: 'quota exceeded' } }) })) as unknown as typeof fetch;
        let errorThrown = false;
        try {
            await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'm1', stream: false, outputContract: 'prompt_only' },
            );
        } catch (e) {
            errorThrown = (e as Error).message.includes('quota');
        }
        check('api：非流式 json.error 抛错（含上游错误信息）', errorThrown);

        // 宿主错误信封：生成失败被宿主包装成 **HTTP 200 + 正常响应壳**
        // （流式补一帧带 `tauritavern-error-chunk-` 前缀 id 的错误帧；
        // 非流式回 `tauritavern-error-` 前缀 id 的 chat.completion）。
        // 不认信封 id，错误正文就会冒充模型产出返回上层——实测事故：整段
        // 错误文本被当成策展 schema 送进人设第二段、prefill 首键派生成
        // 「连接目标服务失败:」。判据只认 id 前缀（不看正文标签）。
        const HOST_ERROR_BODY = '[API 错误]\n连接目标服务失败：当前网络、VPN、代理或接口地址可能暂时不可用。';
        globalThis.fetch = (async () => fakeSSEStream([
            `data: ${JSON.stringify({ id: 'tauritavern-error-chunk-1791461520', choices: [{ delta: { content: HOST_ERROR_BODY } }] })}\n\n`,
            'data: [DONE]\n\n',
        ])) as typeof fetch;
        let streamEnvelopeThrown = '';
        try {
            await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'm1', stream: true, outputContract: 'prompt_only' },
            );
        } catch (e) {
            streamEnvelopeThrown = (e as Error).message;
        }
        const streamEnvelopeRecord = useRunlogStore().records[useRunlogStore().records.length - 1];
        check('api：流式宿主错误信封抛错（id 前缀判别、错误正文不冒充产出、runlog 记失败）',
            streamEnvelopeThrown.includes('连接目标服务失败')
            && !!streamEnvelopeRecord && streamEnvelopeRecord.ok === false
            && (streamEnvelopeRecord.error ?? '').includes('连接目标服务失败'),
            `thrown=${streamEnvelopeThrown.slice(0, 40)}`);

        globalThis.fetch = (async () => ({
            ok: true, status: 200,
            json: async () => ({ id: 'tauritavern-error-1791461520', choices: [{ message: { content: HOST_ERROR_BODY }, finish_reason: 'stop' }] }),
        })) as unknown as typeof fetch;
        let plainEnvelopeThrown = '';
        try {
            await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'm1', stream: false, outputContract: 'prompt_only' },
            );
        } catch (e) {
            plainEnvelopeThrown = (e as Error).message;
        }
        check('api：非流式宿主错误信封抛错（id 前缀判别）',
            plainEnvelopeThrown.includes('连接目标服务失败'), `thrown=${plainEnvelopeThrown.slice(0, 40)}`);

        // 反向守门：判据只认信封 id——正常产出即使正文恰好以错误标签开头
        // 也必须照常收下（文本判别会在这里误杀）。
        globalThis.fetch = (async () => fakeSSEStream([
            `data: ${JSON.stringify({ id: 'chatcmpl-normal-1', choices: [{ delta: { content: '[API Error]\n这是我写的示例文本' } }] })}\n\n`,
            'data: [DONE]\n\n',
        ])) as typeof fetch;
        let labelLookalike = '';
        try {
            const r = await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'm1', stream: true, outputContract: 'prompt_only' },
            );
            labelLookalike = r.content;
        } catch {
            labelLookalike = '(误抛)';
        }
        check('api：正常产出正文以错误标签开头不被误杀（判据只认信封 id、不看正文文本）',
            labelLookalike.includes('这是我写的示例文本'), `content=${labelLookalike.slice(0, 30)}`);

        // 流内上游错误帧（真实事故帧样本，抄自 llm-api-3158.response.sse 第 2 行
        // ——原文随宿主日志轮转清除、事后追不回，故进夹具）：流已开后上游 400
        // 被宿主原样转发，无信封 id、无 choices。不认它＝失败被记成 ok 空响应。
        globalThis.fetch = (async () => fakeSSEStream([
            `data: {"error":{"message":"upstream status 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"Requests ending with a model turn are not supported.\\",\\"status\\":\\"INVALID_ARGUMENT\\"}}","type":"invalid_request_error","param":null,"code":"invalid_argument"}}\n\n`,
        ])) as unknown as typeof fetch;
        let upstreamFrameThrown = '';
        try {
            await callGenerateEndpoint(
                [{ role: 'user', content: 'hi' }],
                { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'm1', stream: true, outputContract: 'prompt_only' },
            );
        } catch (e) {
            upstreamFrameThrown = (e as Error).message;
        }
        const upstreamFrameRecord = useRunlogStore().records[useRunlogStore().records.length - 1];
        check('api：流内上游错误帧抛错（error 对象判别、文案保留上游原文、runlog 记失败不再伪装 ok 空响应）',
            upstreamFrameThrown.includes('Requests ending with a model turn are not supported.')
            && upstreamFrameThrown.includes('upstream status 400')
            && !!upstreamFrameRecord && upstreamFrameRecord.ok === false
            && (upstreamFrameRecord.error ?? '').includes('Requests ending with a model turn'),
            `thrown=${upstreamFrameThrown.slice(0, 60)}`);

        // 反向守门：部分上游的正常帧带 error:null 键——null 不算错误帧，照常收下
        globalThis.fetch = (async () => fakeSSEStream([
            'data: {"error":null,"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n',
        ])) as unknown as typeof fetch;
        const rErrorNull = await callGenerateEndpoint(
            [{ role: 'user', content: 'hi' }],
            { task: 'persona', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'm1', stream: true, outputContract: 'prompt_only' },
        );
        check('api：正常帧带 error:null 不误杀（null 键照常收下 delta）', rErrorNull.content === '好', `text=${rErrorNull.content}`);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

// ---------------------------------------------------------------------------
// 6) persona 端到端（统一端点两段链：curator→personaGen 走引擎管线）
// ---------------------------------------------------------------------------

async function runPersonaE2EChecks(): Promise<void> {
    const store = usePersonaStore();
    // 服务商表放一个冒烟服务商，各任务行全部指向它
    writeApiDomain([{ id: 'smoke-endpoint', name: '冒烟服务商', url: 'https://smoke.example.com/v1', key: 'sk-smoke', models: ['smoke-model'], noPrefill: false }]);
    seedTaskProfiles('smoke-endpoint', 'smoke-model');
    store.requestText = '生成一个侦探人设';
    store.isProcessing = false;

    const CURATOR_YAML = '```yaml\n基本信息:\n姓名:\n年龄:\n```';
    const PERSONA_YAML = '```yaml\n姓名: 阿德\n年龄: 20\n```';
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    // 流式 SSE 桩（stream 恒开——TASK_PARAMS）：content 走 delta 帧
    const sseResponse = (content: string): Response => ({
        ok: true,
        status: 200,
        body: {
            getReader: () => {
                const encoder = new TextEncoder();
                const frames = [
                    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
                    encoder.encode('data: [DONE]\n\n'),
                ];
                return {
                    read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true },
                    cancel: async () => undefined,
                };
            },
        },
    } as unknown as Response);
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        calls.push({ url: String(url), body });
        const content = calls.length === 1 ? CURATOR_YAML : PERSONA_YAML;
        return sseResponse(content);
    }) as typeof fetch;
    try {
        await store.generate();
        const firstMessages = (calls[0]?.body.messages ?? []) as Array<{ role: string; content: string }>;
        const firstJoined = firstMessages.map(m => m.content).join('\n');
        const secondMessages = (calls[1]?.body.messages ?? []) as Array<{ role: string; content: string }>;
        const secondJoined = secondMessages.map(m => m.content).join('\n');
        const lastFirst = firstMessages[firstMessages.length - 1];
        const lastSecond = secondMessages[secondMessages.length - 1];
        check('端到端：统一端点请求形状（宿主路由、quiet、custom 源透传、reverse_proxy=端点地址、温度 1、不发 max_tokens、流式恒开、思考强度 high）',
            // chat_completion_source 恒 'custom' 是跨模块契约：宿主按源分派
            // 错误帧形状，只有 OpenAI 形态带 id 前缀（claude/makersuite 等
            // 支不带，custom 不在其列）——host/api-error.ts 的信封判据有效
            // 性系于此。改此处出站源必须连同那边的判据与核实记录一起复核。
            calls.length === 2
            && calls[0].url === '/api/backends/chat-completions/generate'
            && calls[0].body.type === 'quiet' && calls[0].body.chat_completion_source === 'custom'
            && calls[0].body.reverse_proxy === 'https://smoke.example.com/v1' && calls[0].body.proxy_password === 'sk-smoke'
            && calls[0].body.model === 'smoke-model' && calls[0].body.temperature === 1
            && !('max_tokens' in calls[0].body) && calls[0].body.stream === true
            && calls[0].body.reasoning_effort === 'high'
            && !('response_format' in calls[0].body));
        check('端到端：curator 段走引擎管线（策展指令全文进 messages＋assistant prefill 追加）',
            firstJoined.includes('[任务：策展人设 schema]') && firstJoined.includes('<reference_modules>')
            && !firstJoined.includes('{{charInfo}}') && !firstJoined.includes('{{userRequirements}}')
            && lastFirst?.role === 'assistant' && lastFirst?.content.startsWith('```yaml'));
        check('端到端：personaGen 段消费策展产出（<target_schema> 含 curator 输出、生成指令在场）',
            secondJoined.includes('[任务：生成用户人设]')
            && secondJoined.includes('Schema Definition') && secondJoined.includes('<target_schema>')
            && secondJoined.includes('基本信息:') && secondJoined.includes('[SYSTEM_OP: LOGIC_CONSTRAINT]')
            && !secondJoined.includes('{{template}}')
            && lastSecond?.role === 'assistant' && lastSecond?.content.startsWith('```yaml'));
        check('端到端：两段链结果落地（结果框 YAML 剥围栏、互斥复位）',
            store.resultText === '姓名: 阿德\n年龄: 20'
            && store.isProcessing === false && store.processingLabel === '',
            `result=${store.resultText}`);

        // 破限注入 e2e：选中「冒烟破限」→ 两段请求的首条消息＝assistant 开场
        // 原文（SSE 桩按调用序回内容，生成正常完成）。「恰一次」机判锁双注入：
        // 前缀在每段全文恰出现一次——调用点漏注与重复注都翻红。key 写入放
        // try/finally 复位：e2e 中途 FAIL 不把键泄漏给后续用例（同进程共享
        // extension_settings 单例，键状态非隔离）
        const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
        writeJailbreakPreset('冒烟破限');
        try {
            store.requestText = '破限注入试验';
            await store.generate();
            const jbFirstMessages = (calls[2]?.body.messages ?? []) as Array<{ role: string; content: string }>;
            const jbSecondMessages = (calls[3]?.body.messages ?? []) as Array<{ role: string; content: string }>;
            const jbFirst = jbFirstMessages[0];
            const jbSecond = jbSecondMessages[0];
            check('端到端：破限注入前缀按原角色恰一次插两段请求最前（双注入守门）',
                calls.length === 4
                && jbFirst.role === 'assistant' && jbFirst.content === '破限开场白'
                && jbSecond.role === 'assistant' && jbSecond.content === '破限开场白'
                && countOccurrences(jbFirstMessages.map(m => m.content).join('\n'), '破限开场白') === 1
                && countOccurrences(jbSecondMessages.map(m => m.content).join('\n'), '破限开场白') === 1
                && jbFirstMessages.length > 1,
                `first=${JSON.stringify(jbFirst)} calls=${calls.length}`);

            // 观测面收敛（dump 前缀段）：选中预设后 dump 的消息段＝实发序列
            // （前缀＋组装，同一 composeOutbound 实现），头部计数行写「= 破限
            // 前缀 P 条 + 组装 M 条」、前缀条目带标注——漏传 prelude 即在此翻红
            const jbDumpText = await (toolkitGlobalPort().prompts as { dump: (task?: string) => Promise<string> } | undefined)
                ?.dump('persona_gen') ?? '';
            check('dump 口：观测面收敛（选中预设＝实发序列含破限前缀段与计数行）',
                jbDumpText.includes('消息数组（') && jbDumpText.includes('= 破限前缀 2 条 + 组装 ')
                && jbDumpText.includes('（破限前缀）') && jbDumpText.includes('破限开场白'),
                `head=${jbDumpText.split('\n').find(l => l.includes('消息数组（')) ?? '（无）'}`);

            // 悬空选中：fail-soft——生成照常、首条回到任务消息（无注入）
            writeJailbreakPreset('不存在预设');
            store.requestText = '悬空破限试验';
            await store.generate();
            const noJbFirst = (calls[4]?.body.messages as Array<{ role: string; content: string }> ?? [])[0];
            check('端到端：破限预设悬空时生成照常且不注入',
                calls.length === 6
                && noJbFirst.role !== 'assistant' && noJbFirst.content !== '破限开场白'
                && store.isProcessing === false,
                `first=${JSON.stringify(noJbFirst)} calls=${calls.length}`);
        } finally {
            writeJailbreakPreset('');
        }

        // 取消通道：挂起不响应的端点（只认 signal）＋「停止」→ 中断传播、
        // 互斥复位、结果不误写、取消不作错误弹报（lastRun.request 换种子
        // 证明第二次生成确已进入链路；轮询等 fetch 真被进入后才取消——
        // 请求中 abort→归类才是主战场，pre-aborted 入口只是兜底）
        let fetchEntered = false; // 闭包内赋值：真值连词判定（初始化字面量会窄化，禁 === true 比较）
        globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
            fetchEntered = true;
            return new Promise<Response>((_resolve, reject) => {
                const abortLike = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
                if (init?.signal?.aborted) abortLike();
                else init?.signal?.addEventListener('abort', abortLike);
            });
        }) as typeof fetch;
        const resultBeforeCancel = store.resultText;
        store.requestText = '取消试验';
        const pending = store.generate();
        for (let i = 0; i < 100 && !fetchEntered; i++) await new Promise(r => setTimeout(r, 1));
        store.cancelGeneration();
        await pending;
        check('端到端：生成可中途停止（请求已发出后取消、归类为取消、复位不误写）',
            fetchEntered
            && store.lastRun?.request === '取消试验'
            && store.isProcessing === false && store.processingLabel === ''
            && store.resultText === resultBeforeCancel,
            `fetchEntered=${String(fetchEntered)} result=${store.resultText}`);

        // 空白正文 fail fast（空白也算空的单点判据）：fetch 桩回纯空白 SSE 流
        // ——curator 段 fail-soft 回退默认模板照常，personaGen 段 finalize 抛
        // 「API 返回为空」。用户可见面三件套机判：错误 toast 在场（toastr
        // 间谍临时接管、验毕删除）、结果框保持原值（falsy 判空下纯空白会
        // 静默成功并置空结果框——保留断言的前提是原值非空）、互斥态干净
        const blankToastErrors: string[] = [];
        const blankWindow = globalThis as unknown as { toastr?: Record<string, (message: string) => void> };
        blankWindow.toastr = { error: message => { blankToastErrors.push(message); } };
        const resultBeforeBlank = store.resultText;
        store.requestText = '空白正文试验';
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
            return sseResponse('  \n\t ');
        }) as typeof fetch;
        try {
            await store.generate();
            check('端到端：空白正文抛「API 返回为空」（两段链走完后错误 toast 在场、结果框保持原值、互斥态干净）',
                calls.length === 8
                && resultBeforeBlank.length > 0 && store.resultText === resultBeforeBlank
                && store.isProcessing === false && store.processingLabel === ''
                && blankToastErrors.length === 1 && blankToastErrors[0].includes('API 返回为空'),
                `toast=${JSON.stringify(blankToastErrors)} result=${store.resultText}`);
        } finally {
            delete blankWindow.toastr;
        }

        // 宿主错误信封在 curator 段：必须抛错中断整条链——第二段不得发出。
        // 事故原型实证：信封不认 → 错误正文当 schema → 第二段照发，prefill
        // 首键派生成「连接目标服务失败:」。判据取「调用数只 +1」＝第二段
        // 根本没发（只断言 toast 会在「发了但第二段也失败」时假绿）。
        const envelopeToastErrors: string[] = [];
        const envelopeWindow = globalThis as unknown as { toastr?: Record<string, (message: string) => void> };
        envelopeWindow.toastr = { error: message => { envelopeToastErrors.push(message); } };
        const callsBeforeEnvelope = calls.length;
        const resultBeforeEnvelope = store.resultText;
        store.requestText = '宿主错误信封试验';
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
            const encoder = new TextEncoder();
            const frames = [
                encoder.encode(`data: ${JSON.stringify({
                    id: 'tauritavern-error-chunk-1791461520',
                    choices: [{ delta: { content: '[API 错误]\n连接目标服务失败：当前网络、VPN、代理或接口地址可能暂时不可用。' } }],
                })}\n\n`),
                encoder.encode('data: [DONE]\n\n'),
            ];
            return {
                ok: true,
                status: 200,
                body: { getReader: () => ({
                    read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true },
                    cancel: async () => undefined,
                }) },
            } as unknown as Response;
        }) as typeof fetch;
        try {
            await store.generate();
            const secondStageSent = calls.length > callsBeforeEnvelope + 1;
            check('端到端：curator 段遇宿主错误信封即中断（第二段不发出、错误 toast 在场、结果框与互斥态干净）',
                calls.length === callsBeforeEnvelope + 1
                && !secondStageSent
                && envelopeToastErrors.length === 1 && envelopeToastErrors[0].includes('连接目标服务失败')
                && store.resultText === resultBeforeEnvelope
                && store.isProcessing === false && store.processingLabel === '',
                `calls=${calls.length - callsBeforeEnvelope} toast=${JSON.stringify(envelopeToastErrors).slice(0, 60)}`);
        } finally {
            delete envelopeWindow.toastr;
        }

        // 流内上游错误帧 e2e（判别性主断言，真跑 runGeneration）：persona 两段
        // 请求均以 assistant prefill 结尾，curator 首发被网关以「末条是模型轮」
        // 400 拒收（真实事故帧）——必须触发去 prefill 重试且第二次成功。锁
        // 用户可见行为（三次实发 fetch body 的末条角色），不锁上游文案形状。
        // 第三段末条＝user 是轮内即学即用的机判：学习落在策展段重试里，
        // 档案段必须接着不带起手词（读入口快照的实现会在此露馅）。
        // 本例直调 runGeneration：事件回调只记账，设置域必须纹丝不动——能力
        // 记忆是组合根（store）的职责，生成链不反写兄弟域。
        let learnedEvents = 0;
        const prefillRetryBefore = calls.length;
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
            if (calls.length === prefillRetryBefore + 1) {
                return fakeSSEStream([
                    `data: {"error":{"message":"upstream status 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"Requests ending with a model turn are not supported.\\",\\"status\\":\\"INVALID_ARGUMENT\\"}}","type":"invalid_request_error","param":null,"code":"invalid_argument"}}\n\n`,
                ]);
            }
            return sseResponse(calls.length === prefillRetryBefore + 2 ? CURATOR_YAML : PERSONA_YAML);
        }) as typeof fetch;
        const prefillProfile = await runGeneration({
            route: { providerId: 'smoke-endpoint', url: 'https://smoke.example.com/v1', key: 'sk-smoke', model: 'smoke-model', temperature: 1, reasoningEffort: 'high', noPrefill: false },
            request: '流内错误帧重试试验',
            wiText: '',
            greetingsText: '',
            onPrefillUnsupported: () => { learnedEvents += 1; },
        });
        const first400 = (calls[prefillRetryBefore]?.body.messages ?? []) as Array<{ role: string }>;
        const retry400 = (calls[prefillRetryBefore + 1]?.body.messages ?? []) as Array<{ role: string }>;
        const afterLearn = (calls[prefillRetryBefore + 2]?.body.messages ?? []) as Array<{ role: string }>;
        check('端到端：流内上游错误帧触发去 prefill 重试（首发末条 assistant、重试末条 user、档案段接着不带起手词、成功落地）',
            calls.length === prefillRetryBefore + 3
            && first400[first400.length - 1]?.role === 'assistant'
            && retry400[retry400.length - 1]?.role === 'user'
            && retry400.length === first400.length - 1
            && afterLearn[afterLearn.length - 1]?.role === 'user'
            && learnedEvents === 1
            && readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill === false
            && prefillProfile === '姓名: 阿德\n年龄: 20',
            `firstLast=${first400[first400.length - 1]?.role} retryLast=${retry400[retry400.length - 1]?.role} `
            + `afterLast=${afterLearn[afterLearn.length - 1]?.role} events=${learnedEvents} `
            + `noPrefill=${String(readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill)} profile=${prefillProfile}`);

        // 学习写穿设置域（判别性主断言，走组合根 store.generate()）：同一场
        // 400 家族事故重跑一次——事件必须经 store 的 handler 落到服务商条目，
        // 直调 runGeneration 不会写（上一断言已锁这条边界）。
        setProviderNoPrefill('smoke-endpoint', false);
        const learnBefore = calls.length;
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
            if (calls.length === learnBefore + 1) {
                return fakeSSEStream([
                    `data: {"error":{"message":"upstream status 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"Requests ending with a model turn are not supported.\\",\\"status\\":\\"INVALID_ARGUMENT\\"}}","type":"invalid_request_error","param":null,"code":"invalid_argument"}}\n\n`,
                ]);
            }
            return sseResponse(calls.length === learnBefore + 2 ? CURATOR_YAML : PERSONA_YAML);
        }) as typeof fetch;
        store.requestText = '学习触发试验';
        await store.generate();
        check('端到端：去 prefill 重试成功后端点条目落 noPrefill=true（学习经组合根写穿设置域）',
            calls.length === learnBefore + 3 && readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill === true,
            `calls=${calls.length - learnBefore} noPrefill=${String(readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill)}`);

        // 已标记端点（学习后的下一轮）：路由经 resolveTaskRoute 带出 noPrefill
        // ＝true，两段实发 body 末条都应是 user（起手词被摘、生成照常成功）
        const gatedBefore = calls.length;
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
            return sseResponse(calls.length === gatedBefore + 1 ? CURATOR_YAML : PERSONA_YAML);
        }) as typeof fetch;
        store.requestText = '已标记端点试验';
        await store.generate();
        const gatedFirst = (calls[gatedBefore]?.body.messages ?? []) as Array<{ role: string }>;
        const gatedSecond = (calls[gatedBefore + 1]?.body.messages ?? []) as Array<{ role: string }>;
        check('端到端：已标记端点两段实发 body 末条均为 user（prefill 被摘、生成照常成功）',
            readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill === true
            && calls.length === gatedBefore + 2
            && gatedFirst[gatedFirst.length - 1]?.role === 'user'
            && gatedSecond[gatedSecond.length - 1]?.role === 'user'
            && store.resultText === '姓名: 阿德\n年龄: 20'
            && store.isProcessing === false,
            `firstLast=${gatedFirst[gatedFirst.length - 1]?.role} secondLast=${gatedSecond[gatedSecond.length - 1]?.role} result=${store.resultText}`);

        // 对照（与学习触发器异向，否则判不了别）：复位后跑「400+prefill →
        // 去 prefill 重试仍 400 失败」——证据不足，不得落标记；两次失败都
        // 真实发生（重试末条 user 证明第二次是无 prefill 的重发），错误
        // toast 带真实事故文案、结果框保持原值（用户可见面锁三件套）
        setProviderNoPrefill('smoke-endpoint', false);
        const failBefore = calls.length;
        const failToastErrors: string[] = [];
        const failWindow = globalThis as unknown as { toastr?: Record<string, (message: string) => void> };
        failWindow.toastr = { error: message => { failToastErrors.push(message); } };
        globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
            calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
            return fakeSSEStream([
                `data: {"error":{"message":"upstream status 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"Requests ending with a model turn are not supported.\\",\\"status\\":\\"INVALID_ARGUMENT\\"}}","type":"invalid_request_error","param":null,"code":"invalid_argument"}}\n\n`,
            ]);
        }) as typeof fetch;
        const resultBeforeFail = store.resultText;
        try {
            store.requestText = '重试仍失败对照试验';
            await store.generate();
        } finally {
            delete failWindow.toastr;
        }
        const failFirst = (calls[failBefore]?.body.messages ?? []) as Array<{ role: string }>;
        const failRetry = (calls[failBefore + 1]?.body.messages ?? []) as Array<{ role: string }>;
        check('端到端：重试仍失败不落标记（两次真实失败、错误 toast 带事故文案、结果框保持原值、noPrefill 保持 false）',
            calls.length === failBefore + 2
            && failFirst[failFirst.length - 1]?.role === 'assistant'
            && failRetry[failRetry.length - 1]?.role === 'user'
            && failToastErrors.length === 1 && failToastErrors[0].includes('upstream status 400')
            && store.resultText === resultBeforeFail && store.isProcessing === false
            && readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill === false,
            `calls=${calls.length - failBefore} toast=${JSON.stringify(failToastErrors).slice(0, 60)} `
            + `result=${store.resultText} noPrefill=${String(readApiDomain().find(p => p.id === 'smoke-endpoint')?.noPrefill)}`);
    } finally {
        globalThis.fetch = originalFetch;
        writeApiDomain([]);
        seedTaskProfiles('', '');
    }
}

// ---------------------------------------------------------------------------
// 7) store 互斥＋会话感知
// ---------------------------------------------------------------------------

async function runStoreChecks(): Promise<void> {
    // collectWorldInfoContext：全量注入（无绑定书＝空桶 → 空白上下文）
    const wiText = await collectWorldInfoContext();
    check('generation：全量注入上下文收集空桶返回空串（不抛错）', typeof wiText === 'string');

    // store 互斥：isProcessing 期间 generate 立即返回
    const store = usePersonaStore();
    store.isProcessing = true;
    store.processingLabel = '占用标记';
    const lastRunBefore = store.lastRun;
    await store.generate();
    check('store：生成期间再触发被互斥忽略（lastRun 不变、label 不变）',
        store.lastRun === lastRunBefore && store.processingLabel === '占用标记');
    store.isProcessing = false;
    store.processingLabel = '';

    // 任务模型未配置 fail fast（档案行空＝未配置态）
    seedTaskProfiles('', '');
    store.requestText = '合成需求';
    const resultBefore = store.resultText;
    await store.generate();
    check('store：任务模型未配置 fail fast（不进生成、互斥态干净、结果不误写）',
        store.isProcessing === false && store.processingLabel === '' && store.resultText === resultBefore);
    seedTaskProfiles('', '');

    // 会话感知：CHAT_CHANGED 处理（lastRun 无条件清空、开场白重置为默认档
    // ＝greetings 在场注入 #0、宿主快照无条件重拉
    // ——读取廉价，指纹门控收益为零；指纹仅用于日志观测）
    const liveStubs = (globalThis as unknown as {
        __TT_SMOKE_STUBS__: {
            characters: unknown[];
            setCharacters(v: unknown[]): void;
            eventSource: { emit(type: string, ...args: unknown[]): unknown };
        };
    }).__TT_SMOKE_STUBS__;
    const backupChars = liveStubs.characters;
    liveStubs.setCharacters([{ data: { first_mes: '你好，旅行者' } }]);
    store.refreshHostData();
    store.lastRun = { request: '旧会话需求', wiText: '旧会话 wiText 快照', greetingsText: '' };
    store.selectGreeting(null);
    store.handleChatChanged();
    check('store：CHAT_CHANGED 重置开场白为默认档（有开场白卡＝注入 #0，显式「不注入」不跨会话）＋清 lastRun',
        store.greetings.length > 0 && store.selectedGreetingIndex === 0 && store.lastRun === null);

    // 接线全链（stub 宿主 emit→eventBus.on 订阅→handleChatChanged）：
    // 直调断言只测 handler 逻辑，此条证订阅真实在位（防接线被误删）
    store.selectGreeting(null);
    liveStubs.eventSource.emit(event_types.CHAT_CHANGED);
    check('store：CHAT_CHANGED 接线全链（宿主 emit→订阅→重置默认档）',
        store.selectedGreetingIndex === 0);

    // 无开场白卡：默认回落「不注入」（null）；验毕恢复空卡基线
    liveStubs.setCharacters([]);
    store.handleChatChanged();
    check('store：无开场白卡默认不注入（greetings 空时重置为 null）',
        store.greetings.length === 0 && store.selectedGreetingIndex === null);
    liveStubs.setCharacters(backupChars);

    // charKey 兜底（stubContext.characterId=null → 'global_no_char'）
    check('store：charKey 兜底 global_no_char（|| 兜底、字符串口径）', store.charKey === 'global_no_char');

    // 显式保存点：persistUserContext 写域
    store.requestText = '保存点需求';
    store.resultText = '姓名: 保存点';
    store.persistUserContext();
    const persisted = readPersonaDomain().userContext;
    check('store：显式保存点写域（persistUserContext 落 userContext）',
        persisted.request === '保存点需求' && persisted.result === '姓名: 保存点');

    // 域写单通道 normalize 回读（未知字段丢弃的显式保真）
    const tt = extension_settings.ttToolkit as Record<string, unknown> | undefined;
    const raw = tt?.persona as Record<string, unknown> | undefined;
    if (raw) raw.junkField = '污染';
    const reread = readPersonaDomain() as unknown as Record<string, unknown>;
    check('storage：域读回 normalize 丢弃未知字段（显式保真纪律）', !('junkField' in reread));
    // 还原（去掉污染键：写域 normalize 单通道自然丢弃）
    writePersonaDomain(d => { d.userContext = { request: '', result: '' }; });
    const after = readPersonaDomain() as unknown as Record<string, unknown>;
    check('storage：写域单通道清理污染键（normalize 落盘）', !('junkField' in after));
}

// ---------------------------------------------------------------------------
// 8) 宿主可变绑定活取用回归（stub 活绑定 setter，快照转出回归红线）
// ---------------------------------------------------------------------------

interface SmokeStubs {
    characters: Record<string, unknown>[];
    chat_metadata: Record<string, unknown>;
    setCharacters(v: Record<string, unknown>[]): void;
    setChatMetadata(v: Record<string, unknown>): void;
    setThisChid(v: string): void;
}

function smokeStubs(): SmokeStubs {
    return (globalThis as unknown as { __TT_SMOKE_STUBS__: SmokeStubs }).__TT_SMOKE_STUBS__;
}

function runHostLiveBindingChecks(): void {
    const stubs = smokeStubs();

    // 1. 读通道活取用：this_chid 运行中变更即跟随
    const backupChars = stubs.characters;
    try {
        stubs.setCharacters([{ name: '卡A' }, { name: '卡B' }]);
        stubs.setThisChid('1');
        check('host 活取用：this_chid 运行中变更即跟随——stub 置新角色索引后 getCurrentCharacter 读到新卡（快照转出回归红线）',
            getCurrentCharacter()?.name === '卡B',
            `name=${String(getCurrentCharacter()?.name)}`);
    } finally {
        stubs.setCharacters(backupChars);
        stubs.setThisChid('0');
    }

    // 2. 写通道活目标：chat_metadata 换引用后写落当前对象、读回当前对象
    // （livenessProbe 是测试探针键，不入 ChatDomain 登记——keyof 豁免）
    const probeKey = 'livenessProbe' as keyof ChatDomain;
    const originalChat = stubs.chat_metadata;
    try {
        stubs.setChatMetadata({});
        setChat(probeKey, { v: 1 });
        const domain = stubs.chat_metadata.ttToolkit as Record<string, unknown> | undefined;
        const probe = domain?.livenessProbe as { v?: number } | undefined;
        check('host 活取用：chat_metadata 换引用后 setChat 写落当前对象、getChat 读当前对象（写通道目标=现取，脱挂写丢失回归红线）',
            (getChat<{ v: number }>(probeKey))?.v === 1 && probe?.v === 1,
            `getChat=${JSON.stringify(getChat(probeKey))} 宿主当前对象=${JSON.stringify(probe)}`);
    } finally {
        stubs.setChatMetadata(originalChat);
    }
}

// ---------------------------------------------------------------------------
// 9) 人设写回渲染通道（宿主描述框/人设列表的刷新调用不能漏）
// ---------------------------------------------------------------------------

interface PersonaWriteStubs {
    power_user: Record<string, unknown>;
    personasCalls: {
        initPersona: number;
        setUserAvatar: number;
        setPersonaDescription: number;
        getUserAvatarsLog: Array<[boolean, string]>;
    };
}

function personaWriteStubs(): PersonaWriteStubs {
    return (globalThis as unknown as { __TT_SMOKE_STUBS__: PersonaWriteStubs }).__TT_SMOKE_STUBS__;
}

/** 存根里登记一个人设（personas 真源＝{头像id: 显示名}）。 */
function seedPersona(stubs: PersonaWriteStubs, avatarId: string, name: string): void {
    const personas = stubs.power_user.personas as Record<string, string>;
    personas[avatarId] = name;
}

/** 刷人设列表的调用计数：渲染调用与幽灵键防御的取名调用同走 getUserAvatars，只有入参能分辨。 */
function rendersFor(log: Array<[boolean, string]>, avatarId: string): number {
    return log.filter(([doRender, openPageAt]) => doRender && openPageAt === avatarId).length;
}

async function runPersonaWriteBackChecks(): Promise<void> {
    const stubs = personaWriteStubs();
    const calls = stubs.personasCalls;
    const descriptionBefore = stubs.power_user.persona_description;
    const setDescBefore = calls.setPersonaDescription;
    const initBefore = calls.initPersona;
    const avatarLogBefore = calls.getUserAvatarsLog.length;
    const personas = stubs.power_user.personas as Record<string, string>;
    const descriptions = stubs.power_user.persona_descriptions as Record<string, { description?: string }>;
    const originalFetch = globalThis.fetch;
    // 建档分支要真走头像上传（默认头像取 PNG → /api/avatars/upload 落盘
    // 才存得住描述）——fetch 桩按 URL 分发，两个方法各回一个够用的响应
    const uploadPath = '1700000000000-smoke-persona.png';
    // 非选中人设：覆盖分支的 setUserAvatar 静默切换面只有第二张头像才可达
    //（它同样要过幽灵键防御——头像文件不在 getUserAvatars 返回表里的键会被
    // 当旧插件脏数据整条删掉），故桩的头像文件表预置了这一张
    const otherAvatarId = 'user-other.png';
    globalThis.fetch = (async (url: string | URL) => (String(url) === '/api/avatars/upload'
        ? { ok: true, status: 200, json: async () => ({ path: uploadPath }) }
        : { ok: true, status: 200, blob: async () => new Blob(['stub']) })) as unknown as typeof fetch;
    try {
        // 建档分支：personas 无同名 → 上传建档（不切选中态，描述框无须重填）
        const created = await upsertPersona('冒烟新建人设', '冒烟描述·建档');
        // 建档的落库结果必须在下一次 upsert 的 cleanGhostPersonaKeys 之前取：
        // uploadPath 不在桩的头像文件表里，再进一次写回就被当幽灵键删掉，
        // 而 avatarId 早在调 initPersona 之前就返回了——不立刻断言等于没断
        check('写回：建档分支 initPersona 恰一次且 personas 与描述符双写落地',
            calls.initPersona - initBefore === 1
            && personas[uploadPath] === '冒烟新建人设'
            && descriptions[uploadPath]?.description === '冒烟描述·建档',
            `initPersona=${calls.initPersona - initBefore} personas=${String(personas[uploadPath])} desc=${String(descriptions[uploadPath]?.description)}`);
        // 覆盖分支：把桩的选中头像登记进 personas（名字即真源键），随后
        // 按名 upsert 必走覆盖分支且命中选中态
        seedPersona(stubs, 'user-default.png', '冒烟已选人设');
        const updated = await upsertPersona('冒烟已选人设', '冒烟描述·覆盖');
        const avatarLog = calls.getUserAvatarsLog.slice(avatarLogBefore);
        check('写回：两条分支都刷人设列表（各一次 getUserAvatars(true, 本人设 id)）',
            created.created && created.avatarId === uploadPath
            && !updated.created && updated.avatarId === 'user-default.png'
            && rendersFor(avatarLog, uploadPath) === 1 && rendersFor(avatarLog, 'user-default.png') === 1,
            `log=${JSON.stringify(avatarLog)} created=${created.avatarId} updated=${updated.avatarId}`);
        check('写回：覆盖选中人设时刷描述框（setPersonaDescription 恰一次、镜像字段与描述符同步为新描述）',
            calls.setPersonaDescription - setDescBefore === 1
            && stubs.power_user.persona_description === '冒烟描述·覆盖'
            && descriptions['user-default.png']?.description === '冒烟描述·覆盖',
            `setPersonaDescription=${calls.setPersonaDescription - setDescBefore} mirror=${String(stubs.power_user.persona_description)}`);
        // 非选中人设覆盖：镜像写与刷描述框都归选中态独占，改走 setUserAvatar
        // 静默切换（列表照刷）。这条分支此前零断言，整段删掉冒烟仍全绿
        seedPersona(stubs, otherAvatarId, '冒烟未选人设');
        const setAvatarBefore = calls.setUserAvatar;
        const setDescBeforeSwitch = calls.setPersonaDescription;
        const switchLogBefore = calls.getUserAvatarsLog.length;
        const mirrorBefore = stubs.power_user.persona_description;
        const switched = await upsertPersona('冒烟未选人设', '冒烟描述·切换');
        const switchLog = calls.getUserAvatarsLog.slice(switchLogBefore);
        check('写回：覆盖非选中人设走 setUserAvatar 静默切换（恰一次、不刷描述框、镜像不动、列表仍刷本人设）',
            !switched.created && switched.avatarId === otherAvatarId
            && calls.setUserAvatar - setAvatarBefore === 1
            && calls.setPersonaDescription - setDescBeforeSwitch === 0
            && stubs.power_user.persona_description === mirrorBefore
            && descriptions[otherAvatarId]?.description === '冒烟描述·切换'
            // 幽灵键防御的取名调用与刷列表调用同走此表，两次以外即纪律漂移
            && switchLog.length === 2 && rendersFor(switchLog, otherAvatarId) === 1,
            `setUserAvatar=${calls.setUserAvatar - setAvatarBefore} setPersonaDescription=${calls.setPersonaDescription - setDescBeforeSwitch} mirror=${String(stubs.power_user.persona_description)} log=${JSON.stringify(switchLog)}`);
    } finally {
        globalThis.fetch = originalFetch;
        delete personas[uploadPath];
        delete personas['user-default.png'];
        delete personas[otherAvatarId];
        delete descriptions[uploadPath];
        delete descriptions['user-default.png'];
        delete descriptions[otherAvatarId];
        stubs.power_user.persona_description = descriptionBefore;
    }
}

/** 冒烟入口（main.ts node 分支调用）。 */
export async function runPersonaSmoke(): Promise<void> {
    console.info('=== persona 迁移/统一端点收编/全任务引擎/纯函数/api 形状/端到端/互斥/写回渲染机判 ===');
    runMigrationChecks();
    runPromptsChecks();
    runPersonaAssemblyChecks();
    await runPersonaAssemblyDumpChecks();
    runPureFunctionChecks();
    await runApiChecks();
    await runPersonaE2EChecks();
    await runStoreChecks();
    runHostLiveBindingChecks();
    await runPersonaWriteBackChecks();
    if (failures.length > 0) {
        console.error(`[persona-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[persona-smoke] OK：迁移幂等（空启动写默认域/2 旧键搬入＋localConfig 退役快照保留/uiState 键退役不读＋域形状收缩＋存量域退役字段丢弃含 v1.3 endpointId 旧键/退休键清理/legacy 快照保留）、统一端点收编（choice 零丢失/persona 撞 id 重分配＋同端点去重/两域 v2 重写＋全局活动键提升 choice 优先/删活动端点联动清空/收编不抹端点能力记忆/二次启动零重写）、全任务提示词引擎（Record 全键＋choice 18 模块红线/旧数组一次写迁移/两套 persona 默认/任务组装管线/模块开关闭环/dump 按任务）、yaml 纯函数（分块/围栏）、api 客户端形状（请求体两档/SSE 帧状态机/流内上游错误帧真实事故样本/error:null 反向守门/非流式错误帧）、端到端两段链（全局键选端点请求形状/curator→personaGen 引擎管线/流内错误帧去 prefill 重试＋轮内即学即用＋生成链不反写设置域/学习经组合根写穿设置域/已标记端点起手词摘除/重试仍失败不落标记＋错误 toast 在场/结果落地）、骨架双源机判、全量注入空桶、store 互斥与显式保存点、CHAT_CHANGED 会话感知（lastRun 清空＋开场白重置默认档）、人设写回渲染通道（建档 initPersona 恰一次＋personas/描述符双写落地/两分支各刷一次列表/覆盖选中人设刷描述框＋镜像同步/覆盖非选中人设走 setUserAvatar 静默切换且不碰描述框与镜像）全部通过。');
}
