/**
 * node 冒烟的 persona 机判部分：迁移幂等＋统一端点收编＋三任务
 * 提示词引擎＋api 客户端形状＋store 互斥。
 *
 * 设计：与 choice/smoke.ts 同构（check() 打 [persona-smoke] PASS/FAIL 行，
 * scripts/smoke.mjs 收口断言）。全部走合成数据——不依赖宿主在场数据，
 * 断言确定性；与浏览器真实数据共用同一条 storage/generation 代码路径
 * （dist 加载即覆盖）。
 */
import { event_types, extension_settings, getCurrentCharacter, getTavernContext, readPresetInjectMessages } from '@/host';
import { toolkitGlobalPort } from '@/global-port';
import { getChat, getGlobal, setChat, setGlobal } from '@/storage/service';
import type { ChatDomain } from '@/storage/service';
import { migratePersonaDomain, readPersonaDomain, writePersonaDomain, LEGACY_KEYS, RETIRED_KEYS } from './storage';
import { DEFAULT_TEMPLATES } from './prompts';
import { parseYamlToBlocks } from './yaml';
import { normalizeApiBase, normalizeApiUrl, buildGenerateBody, callGenerateEndpoint, testConnection } from '@/modules/apis/client';
import { useRunlogStore } from '@/modules/runlog/store';
import { migrateApiDomain } from '@/modules/apis/migration';
import { ACTIVE_ENDPOINT_KEY, deleteEndpoint, readActiveEndpointId, readApiDomain, setActiveEndpointId, writeApiDomain, writeJailbreakPreset } from '@/modules/apis/storage';
import { DEFAULTS_VERSION, TASK_KEYS, createTaskDefaultConfig, ensurePromptConfigs, usePromptsStore, assembleMessages, GLOBAL_PROMPT_CONFIGS_KEY, type PersonaAssemblySources } from '@/prompts';
import { stripYamlFence, collectWorldInfoContext } from './generation';
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

/** 统一端点表＋choice 域＋全局活动键整体抹掉（收编场景需要三域＋全局键从零起步）。 */
function wipeApiScenarioDomains(): void {
    const tt = extension_settings.ttToolkit as Record<string, unknown> | undefined;
    if (tt) {
        delete tt.apis;
        delete tt.choice;
        delete tt.persona;
        delete tt[ACTIVE_ENDPOINT_KEY];
    }
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
    const endpoints = readApiDomain();
    const c1 = endpoints.find(e => e.id === 'c1');
    const c2 = endpoints.find(e => e.id === 'c2');
    const remapped = endpoints.find(e => e.url === 'https://persona.example.net/v1' && e.model === 'm-persona');
    check('收编：choice 旧 apis 并入统一表（id 保留、字段零丢失）',
        !report.skipped && report.collectedFrom.includes('choice') && report.endpointCount === 3
        && !!c1 && c1.name === 'choice端点一' && c1.url === 'https://choice.example.com/v1' && c1.key === 'sk-c1' && c1.model === 'm-choice'
        && !!c2 && c2.url === 'https://choice-two.example.com/v1' && c2.key === 'sk-c2' && c2.model === 'm-choice-2');
    check('收编：persona 侧撞 id 重分配＋同端点去重（idRemaps/mergedDuplicates）',
        report.mergedDuplicates === 1
        && report.idRemaps.length === 1 && report.idRemaps[0].from === 'c2' && typeof report.idRemaps[0].to === 'string'
        && !!remapped && remapped.id !== 'c2' && remapped.name === '撞车档',
        `remaps=${JSON.stringify(report.idRemaps)} merged=${report.mergedDuplicates}`);
    const rawChoice = (tt.choice ?? {}) as Record<string, unknown>;
    check('收编：choice 域 v2 重写（全局活动键提升＝activeApiId 重映射＋产物 {gen,pool} 无 task 键）',
        readActiveEndpointId() === 'c2'
        && !('task' in rawChoice)
        && ((rawChoice.gen ?? {}) as Record<string, unknown>).count === 5
        && Array.isArray(((rawChoice.pool ?? {}) as Record<string, unknown>).masterPool)
        && !('apis' in rawChoice) && !('activeApiId' in rawChoice),
        `choice=${JSON.stringify(rawChoice)}`);
    const afterCollect = readPersonaDomain();
    check('收编：persona 域 v2 重写（整键清洗后无 localConfig/uiState 键；选中不参与提升——choice 优先）',
        !('localConfig' in (afterCollect as unknown as Record<string, unknown>))
        && !('localConfig' in rawPersona())
        && !('uiState' in (afterCollect as unknown as Record<string, unknown>)));

    // 1f. 二次启动零重写（统一表在场＋两域 v2 → 全部 skip，逐字节不变）
    const apisBefore = JSON.stringify(tt.apis);
    const choiceBefore = JSON.stringify(tt.choice);
    const personaBefore = domainJson();
    const personaSecond = migratePersonaDomain();
    const apisSecond = migrateApiDomain();
    check('收编：二次启动零重写（两步迁移均 skip、三域逐字节不变）',
        personaSecond.skipped && apisSecond.skipped
        && JSON.stringify(tt.apis) === apisBefore
        && JSON.stringify(tt.choice) === choiceBefore
        && domainJson() === personaBefore);

    // 1h. 删活动端点 → 全局选中键联动清空（回未选态，两任务生成入口 fail fast）
    writeApiDomain([{ id: 'smoke-del', name: '待删端点', url: 'https://del.example.com/v1', key: 'k', model: 'm' }]);
    setActiveEndpointId('smoke-del');
    deleteEndpoint('smoke-del');
    check('端点删除：删活动端点联动清空全局选中键（回未选态）',
        readActiveEndpointId() === '' && readApiDomain().every(e => e.id !== 'smoke-del'));

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
// 2) 三任务提示词引擎（存储形态＋默认模板＋任务键）
// ---------------------------------------------------------------------------

function runPromptsChecks(): void {
    const prompts = usePromptsStore();
    const raw = getGlobal(GLOBAL_PROMPT_CONFIGS_KEY) as unknown;
    const record = (raw ?? {}) as Record<string, unknown>;
    const choiceModules = (record.choice as { modules?: unknown[] } | undefined)?.modules;
    check('prompts：三任务键 Record 齐备（choice 18 模块回归红线）',
        !Array.isArray(raw) && typeof raw === 'object' && raw !== null
        && TASK_KEYS.every(k => record[k] !== undefined)
        && Array.isArray(choiceModules) && choiceModules.length === 18
        && prompts.configFor('persona_curator') !== null
        && prompts.configFor('persona_gen') !== null,
        `keys=${Object.keys(record).join('/')}`);

    // 旧档（单元素数组）→ Record 一次性迁移：choice id 保留＋补缺三键。
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

    // 默认配置版本化重建：旧默认快照（无 defaultsVersion）启动后被整键
    // 重建为新版并盖版本号（id!=='default' 的定制键不覆盖——防御分支）
    const withStale = getGlobal(GLOBAL_PROMPT_CONFIGS_KEY) as Record<string, unknown>;
    setGlobal(GLOBAL_PROMPT_CONFIGS_KEY, {
        ...withStale,
        persona_gen: { id: 'default', name: '默认', modules: [] },
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
    check('prompts：默认用户人设模板五块（基本信息/外貌/性格/喜恶/背景）',
        keys.length === 5 && ['基本信息', '外貌', '性格', '喜恶', '背景'].every(k => keys.includes(k)),
        `blocks=${keys.join('/')}`);

    // 骨架双源机判：回退骨架（DEFAULT_TEMPLATES.user）的性格叶键名与
    // 策展清单 <reference_modules> 性格行声明一致——两处原文包含性比对，
    // 改策展清单漏改回退骨架在此翻红（对齐不再靠注释纪律）
    const personaLeaves = (templateBlocks.get('性格') ?? '')
        .split('\n').map(l => l.trim().replace(/:$/, '')).filter(Boolean);
    const curatorLine = curatorText.split('\n').find(l => l.startsWith('性格——')) ?? '';
    check('prompts：骨架双源机判（回退骨架性格三叶＝策展清单性格行声明）',
        curatorLine !== ''
        && personaLeaves.length === 3
        && ['核心矛盾', '情绪反应', '说话风格'].every(k => personaLeaves.includes(k) && curatorLine.includes(k)),
        `骨架叶=${personaLeaves.join('/')} 清单行=${curatorLine}`);
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
            getReader: () => ({
                read: async () => queue.length > 0 ? { done: false, value: queue.shift() } : { done: true },
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
    check('api：buildGenerateBody 基础形状（quiet/openai/reverse_proxy/proxy_password/tool_choice；缺省温度与 max_tokens 不发）',
        body.type === 'quiet' && body.chat_completion_source === 'openai'
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

    // fetch 桩：testConnection 实际发出形状（model+max_tokens:5+Hi 消息）
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
    try {
        const res = await testConnection('https://api.example.com/v1', 'sk-test', 'm1');
        const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
        check('api：测连 fetch 桩形状（/chat/completions、Bearer、model、max_tokens:5、Hi 消息）',
            res.ok && calls.length === 1
            && calls[0].url === 'https://api.example.com/v1/chat/completions'
            && sent.model === 'm1' && sent.max_tokens === 5
            && Array.isArray(sent.messages) && (sent.messages as Array<{ content: string }>)[0].content === 'Hi'
            && String((calls[0].init.headers as Record<string, string>).Authorization) === 'Bearer sk-test');
    } finally {
        globalThis.fetch = originalFetch;
    }

    // SSE 帧状态机（经 callGenerateEndpoint 公共面）
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
    } finally {
        globalThis.fetch = originalFetch;
    }
}

// ---------------------------------------------------------------------------
// 6) persona 端到端（统一端点两段链：curator→personaGen 走引擎管线）
// ---------------------------------------------------------------------------

async function runPersonaE2EChecks(): Promise<void> {
    const store = usePersonaStore();
    // 端点表放一个冒烟端点，全局活动键指向它
    writeApiDomain([{ id: 'smoke-endpoint', name: '冒烟端点', url: 'https://smoke.example.com/v1', key: 'sk-smoke', model: 'smoke-model' }]);
    setActiveEndpointId('smoke-endpoint');
    store.requestText = '生成一个侦探人设';
    store.isProcessing = false;

    const CURATOR_YAML = '```yaml\n基本信息:\n姓名:\n年龄:\n```';
    const PERSONA_YAML = '```yaml\n姓名: 阿德\n年龄: 20\n```';
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    // 流式 SSE 桩（stream 恒开——TASK_DEFAULTS）：content 走 delta 帧
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
                return { read: async () => frames.length > 0 ? { done: false, value: frames.shift() } : { done: true } };
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
        check('端到端：统一端点请求形状（宿主路由、quiet、reverse_proxy=端点地址、温度 1、不发 max_tokens、流式恒开、思考强度 high）',
            calls.length === 2
            && calls[0].url === '/api/backends/chat-completions/generate'
            && calls[0].body.type === 'quiet' && calls[0].body.chat_completion_source === 'openai'
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
    } finally {
        globalThis.fetch = originalFetch;
        writeApiDomain([]);
        setActiveEndpointId('');
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

    // 端点缺失 fail fast（全局活动键悬空指向）
    setActiveEndpointId('no-such-endpoint');
    store.requestText = '合成需求';
    const resultBefore = store.resultText;
    await store.generate();
    check('store：端点缺失 fail fast（不进生成、互斥态干净、结果不误写）',
        store.isProcessing === false && store.processingLabel === '' && store.resultText === resultBefore);
    setActiveEndpointId('');

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

/** 冒烟入口（main.ts node 分支调用）。 */
export async function runPersonaSmoke(): Promise<void> {
    console.info('=== persona 迁移/统一端点收编/三任务引擎/纯函数/api 形状/端到端/互斥机判 ===');
    runMigrationChecks();
    runPromptsChecks();
    runPersonaAssemblyChecks();
    await runPersonaAssemblyDumpChecks();
    runPureFunctionChecks();
    await runApiChecks();
    await runPersonaE2EChecks();
    await runStoreChecks();
    runHostLiveBindingChecks();
    if (failures.length > 0) {
        console.error(`[persona-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[persona-smoke] OK：迁移幂等（空启动写默认域/2 旧键搬入＋localConfig 退役快照保留/uiState 键退役不读＋域形状收缩＋存量域退役字段丢弃含 v1.3 endpointId 旧键/退休键清理/legacy 快照保留）、统一端点收编（choice 零丢失/persona 撞 id 重分配＋同端点去重/两域 v2 重写＋全局活动键提升 choice 优先/删活动端点联动清空/二次启动零重写）、三任务提示词引擎（Record 三键＋choice 18 模块红线/旧数组一次写迁移/两套 persona 默认/任务组装管线/模块开关闭环/dump 按任务）、yaml 纯函数（分块/围栏）、api 客户端形状（请求体两档/SSE 帧状态机/非流式错误帧）、端到端两段链（全局键选端点请求形状/curator→personaGen 引擎管线/结果落地）、骨架双源机判、全量注入空桶、store 互斥与显式保存点、CHAT_CHANGED 会话感知（lastRun 清空＋开场白重置默认档）全部通过。');
}
