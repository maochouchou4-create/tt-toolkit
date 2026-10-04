/**
 * node 冒烟的批D 机判部分：persona 迁移幂等＋纯函数＋api 请求体形状＋
 * store 互斥。
 *
 * 设计：与 choice/smoke.ts 同构（check() 打 [persona-smoke] PASS/FAIL 行，
 * scripts/smoke.mjs 收口断言）。全部走合成数据——不依赖宿主在场数据，
 * 断言确定性；与浏览器真实数据共用同一条 storage/generation 代码路径
 * （dist 加载即覆盖）。
 */
import { extension_settings } from '@/host';
import { migratePersonaDomain, readPersonaDomain, writePersonaDomain, LEGACY_KEYS, RETIRED_KEYS, clampTimeout } from './storage';
import { DEFAULT_PROMPTS, DEFAULT_TEMPLATES } from './prompts';
import { parseYamlToBlocks } from './yaml';
import { computeDiffBlocks, assembleDiffResult } from './diff';
import { buildOpenAIRequest, normalizeApiBase, readSSEResponse, testConnection } from './api';
import { stripYamlFence, collectWorldInfoContext } from './generation';
import { generateSmartKeywords, syncPersonaToWorldInfo } from './worldbook';
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

function domainJson(): string {
    return JSON.stringify(readPersonaDomain());
}

// ---------------------------------------------------------------------------
// 1) 迁移幂等（空 localStorage→写域；旧键→搬入；二次启动零重写）
// ---------------------------------------------------------------------------

function runMigrationChecks(): void {
    // 清场：域+全部旧键+退休键
    wipeDomain();
    for (const key of Object.values(LEGACY_KEYS)) ls.remove(key);
    for (const key of RETIRED_KEYS) ls.remove(key);

    // 1a. 空 localStorage → 写默认域
    const first = migratePersonaDomain();
    const defaults = readPersonaDomain();
    check('迁移：空 localStorage 首启动写入默认域（apiSource=main、preset=current）',
        !first.skipped && first.migratedKeys.length === 0
        && defaults.localConfig.apiSource === 'main'
        && defaults.uiState.generationPreset === 'current'
        && defaults.userContext.request === '' && !defaults.userContext.hasResult,
        `skipped=${first.skipped} migrated=${first.migratedKeys.join(',') || '无'}`);

    // 1b. 预置 5 旧键 + 1 退休键 → 域缺席 → 搬入
    const legacyState = {
        localConfig: {
            apiSource: 'independent',
            indepApiUrl: 'https://relay.example.com/v1',
            indepApiKey: 'sk-legacy',
            indepApiModel: 'deepseek-chat',
            indepTimeout: 600,
            indepStream: false,
            thinkingEffort: 'high',
            extraBooks: ['pinned-book'],
            // 注意：无 apiProfiles（触发收档迁移「默认配置 1」）
        },
    };
    ls.set(LEGACY_KEYS.state, JSON.stringify(legacyState));
    ls.set(LEGACY_KEYS.wiSelection, JSON.stringify({ charA: { 'Book One': ['1', '2'] } }));
    ls.set(LEGACY_KEYS.uiState, JSON.stringify({ generationPreset: 'Pure' }));
    ls.set(LEGACY_KEYS.dataUser, JSON.stringify({ request: '写个侦探', result: '姓名: 阿德', hasResult: true, template: '旧字段应被丢弃' }));
    ls.set(LEGACY_KEYS.pinnedBooks, JSON.stringify(['pinned-book']));
    ls.set('pw_template_v6_new_yaml', '旧退休键残留');
    wipeDomain();

    const second = migratePersonaDomain();
    const migrated = readPersonaDomain();
    check('迁移：5 旧键全部搬入（migratedKeys 齐）',
        second.migratedKeys.length === 5
        && LEGACY_KEYS.state && second.migratedKeys.includes(LEGACY_KEYS.state)
        && second.migratedKeys.includes(LEGACY_KEYS.wiSelection)
        && second.migratedKeys.includes(LEGACY_KEYS.uiState)
        && second.migratedKeys.includes(LEGACY_KEYS.dataUser)
        && second.migratedKeys.includes(LEGACY_KEYS.pinnedBooks),
        `migrated=${second.migratedKeys.join(',')}`);
    check('迁移：localConfig 字段全家平移（url/key/model/timeout/stream/effort/extraBooks）',
        migrated.localConfig.apiSource === 'independent'
        && migrated.localConfig.indepApiUrl === 'https://relay.example.com/v1'
        && migrated.localConfig.indepApiKey === 'sk-legacy'
        && migrated.localConfig.indepApiModel === 'deepseek-chat'
        && migrated.localConfig.indepTimeout === 600
        && migrated.localConfig.indepStream === false
        && migrated.localConfig.thinkingEffort === 'high'
        && migrated.localConfig.extraBooks.includes('pinned-book'));
    check('迁移：apiProfiles 收档「默认配置 1」（旧档无 profiles 时收现值并选中）',
        migrated.localConfig.apiProfiles.length === 1
        && migrated.localConfig.apiProfiles[0].name === '默认配置 1'
        && migrated.localConfig.apiProfiles[0].url === 'https://relay.example.com/v1'
        && migrated.localConfig.apiProfiles[0].key === 'sk-legacy'
        && migrated.localConfig.activeApiProfileId === migrated.localConfig.apiProfiles[0].id);
    check('迁移：wiSelection/uiState/userContext/pinnedBooks 形状正确（淘汰字段丢弃）',
        JSON.stringify(migrated.wiSelection) === JSON.stringify({ charA: { 'Book One': ['1', '2'] } })
        && migrated.uiState.generationPreset === 'Pure'
        && migrated.userContext.request === '写个侦探' && migrated.userContext.result === '姓名: 阿德' && migrated.userContext.hasResult
        && !('template' in (migrated.userContext as unknown as Record<string, unknown>))
        && migrated.pinnedBooks.includes('pinned-book'));
    check('迁移：退休键 removeItem 清理（pw_template_v6_new_yaml）',
        second.retiredKeysCleaned.includes('pw_template_v6_new_yaml') && ls.get('pw_template_v6_new_yaml') === null);
    check('迁移：旧键保留作 legacy 快照（防回滚丢增量）',
        ls.get(LEGACY_KEYS.state) !== null && ls.get(LEGACY_KEYS.dataUser) !== null && ls.get(LEGACY_KEYS.pinnedBooks) !== null);

    // 1c. 二次启动零重写（域在场 → skipped，域内容逐字节不变）
    const before = domainJson();
    const third = migratePersonaDomain();
    check('迁移：二次启动零重写（域在场 skip、内容不变、无搬入）',
        third.skipped && third.migratedKeys.length === 0 && domainJson() === before);

    // 1d. 退休键清理无条件（域在场也清）——已由 1c 前置移除，这里再放回验证
    ls.set('pw_custom_themes_v1', '残留');
    const fourth = migratePersonaDomain();
    check('迁移：域在场时退休键清理仍执行（pw_custom_themes_v1）',
        fourth.skipped && fourth.retiredKeysCleaned.includes('pw_custom_themes_v1') && ls.get('pw_custom_themes_v1') === null);

    // 清场还原默认域（后续分区读域不依赖本段合成数据）
    for (const key of Object.values(LEGACY_KEYS)) ls.remove(key);
    wipeDomain();
    migratePersonaDomain();
}

// ---------------------------------------------------------------------------
// 2) prompts 常量形状
// ---------------------------------------------------------------------------

function runPromptsChecks(): void {
    check('prompts：curator 策展提示词在场（占位符 {{charInfo}}/{{userRequirements}}）',
        DEFAULT_PROMPTS.curator.includes('{{charInfo}}') && DEFAULT_PROMPTS.curator.includes('{{userRequirements}}'));
    check('prompts：personaGen 生成/润色提示词在场（占位符 {{user}}/{{charInfo}}/{{greetings}}/{{template}}/{{input}}）',
        DEFAULT_PROMPTS.personaGen.includes('{{user}}') && DEFAULT_PROMPTS.personaGen.includes('{{charInfo}}')
        && DEFAULT_PROMPTS.personaGen.includes('{{greetings}}') && DEFAULT_PROMPTS.personaGen.includes('{{template}}')
        && DEFAULT_PROMPTS.personaGen.includes('{{input}}'));
    const templateBlocks = parseYamlToBlocks(DEFAULT_TEMPLATES.user);
    const keys = [...templateBlocks.keys()];
    check('prompts：默认用户人设模板六块（基本信息/外貌/性格/背景/喜恶/NSFW）',
        keys.length === 6 && ['基本信息', '外貌', '性格', '背景', '喜恶', 'NSFW'].every(k => keys.includes(k)),
        `blocks=${keys.join('/')}`);
    check('prompts：模板姓名占位符 {{user}} 在场（宏替换链路依赖）',
        DEFAULT_TEMPLATES.user.includes('{{user}}'));
}

// ---------------------------------------------------------------------------
// 3) yaml/diff 纯函数行为
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

    // diff 块级 LCS
    const oldText = '姓名: 阿德\n年龄: 20\n职业: 侦探';
    const newText = '姓名: 阿德\n年龄: 25\n职业: 私家侦探';
    const diffBlocks = computeDiffBlocks(oldText, newText);
    const diffPieces = diffBlocks.filter(b => b.type === 'diff');
    check('diff：等值块保持＋差异块成对（old/new 文本）',
        diffBlocks.some(b => b.type === 'equal' && b.value.includes('姓名: 阿德'))
        && diffPieces.length > 0
        && diffPieces.every(b => b.oldText !== b.newText));
    check('diff：默认采纳 new 侧＋assembleDiffResult 拼装',
        diffPieces.every(b => b.active === 'new') && assembleDiffResult(diffBlocks) === newText);
    if (diffPieces.length > 0) diffPieces[0].active = 'old';
    const mixed = assembleDiffResult(diffBlocks);
    check('diff：切换 active 侧后取舍生效（混合结果 ≠ 纯 new）',
        mixed !== newText && mixed.includes('姓名: 阿德'));
}

// ---------------------------------------------------------------------------
// 4) api.ts 请求体形状（fetch 桩）
// ---------------------------------------------------------------------------

function fakeSSEStream(chunks: string[]): { body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } } {
    const encoder = new TextEncoder();
    const queue = chunks.map(c => encoder.encode(c));
    return {
        body: {
            getReader: () => ({
                read: async () => queue.length > 0 ? { done: false, value: queue.shift() } : { done: true },
            }),
        },
    };
}

async function runApiChecks(): Promise<void> {
    // 纯函数：端点规范化
    check('api：normalizeApiBase 剥尾斜杠+/chat/completions（保留 /v1）',
        normalizeApiBase('https://api.example.com/v1/chat/completions/') === 'https://api.example.com/v1'
        && normalizeApiBase('https://api.example.com') === 'https://api.example.com');

    // 纯函数：请求体形状（温度固定 1.00；max_tokens 恒不注入；effort off 不发）
    const req = buildOpenAIRequest(
        [{ role: 'user', content: 'hi' }],
        { url: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'm1', stream: false, thinkingEffort: 'off' },
        false,
    );
    const body = req.body as Record<string, unknown>;
    check('api：请求体形状（model/messages/temperature=1.00、无 max_tokens、无 reasoning_effort、无 stream）',
        body.model === 'm1' && Array.isArray(body.messages) && body.temperature === 1.00
        && !('max_tokens' in body) && !('reasoning_effort' in body) && !('stream' in body)
        && req.url === 'https://api.example.com/v1/chat/completions'
        && req.headers.Authorization === 'Bearer sk-test');
    const reqEffort = buildOpenAIRequest(
        [{ role: 'user', content: 'hi' }],
        { url: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'm1', stream: true, thinkingEffort: 'high' },
        true,
    );
    const bodyEffort = reqEffort.body as Record<string, unknown>;
    check('api：effort≠off 注入 reasoning_effort＋流式注入 stream',
        bodyEffort.reasoning_effort === 'high' && bodyEffort.stream === true);

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

    // SSE 解析：字符串 delta + 数组 delta 双形态 + [DONE] + 双帧分隔
    const sse1 = fakeSSEStream(['data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":[{"type":"text","text":"好"}]}}]}\n\ndata: [DONE]\n\n']);
    const text1 = await readSSEResponse(sse1 as unknown as Response);
    check('api：SSE 解析（delta.content 字符串/数组双形态、[DONE]、\\n\\n 分帧）', text1 === '你好', `text=${text1}`);
    const sse2 = fakeSSEStream(['data: {"choices":[{"delta":{"content":"甲"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"乙"}}]}']);
    const text2 = await readSSEResponse(sse2 as unknown as Response);
    check('api：SSE 解析（\\r\\n\\r\\n 分帧＋流尾无空行补处理）', text2 === '甲乙', `text=${text2}`);

    // SSE 错误帧抛错
    let errorFrameThrown = false;
    try {
        await readSSEResponse(fakeSSEStream(['data: {"error":{"message":"quota"}}\n\n']) as unknown as Response);
    } catch (e) {
        errorFrameThrown = (e as Error).message.includes('quota');
    }
    check('api：SSE 错误帧抛错（含上游错误信息）', errorFrameThrown);

    // 空流抛错（反代吞文本场景）
    let emptyThrown = false;
    try {
        await readSSEResponse(fakeSSEStream(['data: [DONE]\n\n']) as unknown as Response);
    } catch (e) {
        emptyThrown = (e as Error).message.includes('流式响应为空');
    }
    check('api：空流响应抛错（提示切回非流式）', emptyThrown);
}

// ---------------------------------------------------------------------------
// 5) worldbook 纯函数＋store 互斥
// ---------------------------------------------------------------------------

async function runWorldbookAndStoreChecks(): Promise<void> {
    // generateSmartKeywords：姓名+别名行拆分+静态 User；短键滤除
    const kw = generateSmartKeywords('林·小霜', '姓名: 林·小霜\n别名: 霜霜、Frost，喵\n', ['User']);
    check('worldbook：智能触发词（别名行拆 /[,，、]/、·取前段、静态 User、短键滤除）',
        kw.includes('林·小霜') && kw.includes('霜霜') && kw.includes('Frost') && kw.includes('User') && kw.every(k => k.length > 1),
        `kw=${kw.join('/')}`);

    // sync 无绑定世界书 → fail fast 抛错
    let wiThrown = false;
    try {
        await syncPersonaToWorldInfo('测试用户', '姓名: 测试用户\n年龄: 20');
    } catch (e) {
        wiThrown = (e as Error).message.includes('未绑定世界书');
    }
    check('worldbook：无绑定世界书 fail fast 抛错（不静默降级）', wiThrown);

    // collectWorldInfoContext：书目 ≤20＋勾选过滤（合成书籍走 stub 空桶 → 空白上下文）
    const wiText = await collectWorldInfoContext({ extraBooks: [], checkedByBook: {}, charKey: 'global_no_char' });
    check('generation：上下文收集空桶返回空串（不抛错）', typeof wiText === 'string');

    // store 互斥：isProcessing 期间 generate/refine 立即返回
    const store = usePersonaStore();
    store.isProcessing = true;
    store.processingLabel = '占用标记';
    store.lastRun = null;
    await store.generate();
    check('store：生成期间再触发被互斥忽略（lastRun 不变、label 不变）',
        store.lastRun === null && store.processingLabel === '占用标记');
    await store.refine();
    check('store：生成期间润色同样被互斥忽略（不进 diff 视图）', !store.showDiff);
    store.isProcessing = false;
    store.processingLabel = '';

    // 主 API 路径：宿主存根无 generateRaw → 抛「酒馆版本过旧」被 store 吞成 toast，
    // finally 复位互斥（不挂死）
    store.requestText = '合成需求';
    await store.generate();
    check('store：主 API generateRaw 缺席路径 fail fast（互斥复位、结果不误写）',
        store.isProcessing === false && store.processingLabel === '');

    // charKey 兜底（stubContext.characterId=null → 'global_no_char'）
    check('store：charKey 兜底 global_no_char（|| 兜底、字符串口径）', store.charKey === 'global_no_char');

    // 超时钳制
    check('storage：请求超时钳制 30..1800', clampTimeout(5) === 30 && clampTimeout(9999) === 1800 && clampTimeout(300) === 300);

    // 划词润色模板（事件直挂语义）
    store.refineText = '';
    store.appendRefineSelection('口头禅');
    check('store：划词润色意见模板追加（对 "选中" 的修改意见为：）',
        store.refineText === '对 "口头禅" 的修改意见为：');

    // 显式保存点：persistUserContext 写域
    store.requestText = '保存点需求';
    store.resultText = '姓名: 保存点';
    store.persistUserContext();
    const persisted = readPersonaDomain().userContext;
    check('store：显式保存点写域（persistUserContext 落 userContext）',
        persisted.request === '保存点需求' && persisted.result === '姓名: 保存点' && persisted.hasResult);

    // 域写单通道 normalize 回读（未知字段丢弃的显式保真）
    const tt = extension_settings.ttToolkit as Record<string, unknown> | undefined;
    const raw = tt?.persona as Record<string, unknown> | undefined;
    if (raw) raw.junkField = '污染';
    const reread = readPersonaDomain() as unknown as Record<string, unknown>;
    check('storage：域读回 normalize 丢弃未知字段（显式保真纪律）', !('junkField' in reread));
    // 还原（去掉污染键：写域 normalize 单通道自然丢弃）
    writePersonaDomain(d => { d.userContext = { request: '', result: '', hasResult: false }; });
    const after = readPersonaDomain() as unknown as Record<string, unknown>;
    check('storage：写域单通道清理污染键（normalize 落盘）', !('junkField' in after));
}

/** 冒烟入口（main.ts node 分支调用）。 */
export async function runPersonaSmoke(): Promise<void> {
    console.info('=== persona 迁移/纯函数/api 形状/互斥机判（批D）===');
    runMigrationChecks();
    runPromptsChecks();
    runPureFunctionChecks();
    await runApiChecks();
    await runWorldbookAndStoreChecks();
    if (failures.length > 0) {
        console.error(`[persona-smoke] ${failures.length} 项 FAIL：${failures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[persona-smoke] OK：迁移幂等（空启动写默认域/5 旧键搬入＋收档/退休键清理/legacy 快照保留/二次启动零重写）、prompts 常量形状（curator/personaGen 六块模板）、yaml/diff 纯函数（分块/围栏/取舍拼装）、api 请求体形状（fetch 桩/SSE 双帧双形态/错误帧/空流）、worldbook 触发词与 fail fast、store 互斥与显式保存点全部通过。');
}
