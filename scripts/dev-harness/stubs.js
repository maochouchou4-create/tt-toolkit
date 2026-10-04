/*
 * dev-harness 宿主 stub（经典脚本，在 app.js 之前加载）。
 * 只实现 tt-toolkit 实际消费的最小面（消费面清单见 README.md），
 * 全部内存态——刷新即重置，可反复折腾布局而不污染真实酒馆。
 *
 * __TT_HARNESS__ 的键与 dist/index.js 的全部外部 import（批D 后 11 条）
 * 一一对应（build.mjs 的 STUBS 表同构）；另有窗口级全局（window.$ /
 * SillyTavern.getContext / quickReplyApi / toastr / STBaiBaiBook）按
 * 宿主挂载形态放到 globalThis 上。
 */
(() => {
    'use strict';

    // --------------------------------------------------------
    // 假酒馆现场数据（贴着旧版调试场景编的探案剧情，让各 tab 有真内容可看）
    // --------------------------------------------------------
    const USER_NAME = '王玉';
    const CHAR_NAME = '林霜';
    // 角色卡 v2 形态：tt-toolkit 读 data 子对象（sources.ts currentCharacter
    // 消费 ch?.data.description/personality/scenario/...），顶层字段不读
    const characters = [
        {
            name: CHAR_NAME,
            data: {
                description: '三十岁上下，旧货铺的守夜人，斗篷人案的关键证人，言辞闪烁。',
                personality: '克制、回避、重旧情。',
                scenario: '深夜的旧货铺后堂，灯只亮了一盏。',
                creator_notes: '用户自定义角色。',
                first_mes: '「这么晚了还来？」林霜头也不抬，手里的算盘拨得噼啪响。',
                alternate_greetings: ['她抬眼看了看门口的动静，把一盏灯往里挪了挪：「后堂说话。」'],
            },
        },
        { name: '阿七', data: { description: '跑腿少年，消息灵通。', personality: '话多、胆小。', scenario: '巷口。' } },
    ];

    const chat = [
        { mes: `${CHAR_NAME}把茶盏往桌上一推：「昨夜的事，你不必再问了。」`, is_user: false, is_system: false },
        { mes: '「那斗篷人到底是谁？」', is_user: true, is_system: false },
        { mes: '她垂下眼，指节在袖口里收紧了半分：「……与我无关。」', is_user: false, is_system: false },
        { mes: '（王玉注意到她袖口滑出半枚铜符，又很快被按了回去。）', is_user: false, is_system: true },
        { mes: '「半枚铜符。另外半枚，在城南当铺的失物册上。」', is_user: true, is_system: false },
        { mes: `${CHAR_NAME}猛地抬头，声音压得极低：「你怎么会有当铺的消息？」`, is_user: false, is_system: false },
    ];

    // 宿主全局单例（写入侧：extension_settings / chat_metadata 被
    // tt-toolkit 的 storage 层直接 mutate，再走保存通道落“盘”）
    const chat_metadata = {};
    const extension_settings = {};
    const power_user = {
        persona_description: `${USER_NAME}，旧货铺的常客，观察力过人，惯于用细节逼人开口。`,
        movingUI: true,
        movingUIState: {},
        // personas 域（批D）：personas.js stub 与 upsertPersona 写回链共用
        // power_user 单例（宿主同形——personas 与 persona_descriptions 都挂
        // power_user 上）
        personas: {},
        persona_descriptions: {},
    };

    // --------------------------------------------------------
    // localStorage 探测：file:// 源下 Playwright Chromium 可用；万一环境
    // 不可用则退化为内存版（保 harness 可开，代价仅刷新丢状态）
    // --------------------------------------------------------
    let storageOk = false;
    try {
        window.localStorage.setItem('__tt_harness_probe__', '1');
        window.localStorage.removeItem('__tt_harness_probe__');
        storageOk = true;
    } catch {
        const memory = new Map();
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            value: {
                getItem: k => (memory.has(String(k)) ? memory.get(String(k)) : null),
                setItem: (k, v) => memory.set(String(k), String(v)),
                removeItem: k => memory.delete(String(k)),
                clear: () => memory.clear(),
            },
        });
    }

    // --------------------------------------------------------
    // events.js stub
    // --------------------------------------------------------
    const event_types = {
        APP_READY: 'app_ready',
        CHAT_CHANGED: 'chat_id_changed',
        MESSAGE_UPDATED: 'message_updated',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        SETTINGS_LOADED: 'settings_loaded',
        // 批D personas 写回链 emit 的两个事件（eventSource.emit stub 通用）
        PERSONA_CREATED: 'persona_created',
        PERSONA_UPDATED: 'persona_updated',
    };
    const handlers = new Map();
    function on(type, fn) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(fn);
        return fn;
    }
    function once(type, fn) {
        const wrapped = data => {
            off(type, wrapped);
            fn(data);
        };
        return on(type, wrapped);
    }
    function off(type, fn) {
        handlers.get(type)?.delete(fn);
    }
    // 真实 EventEmitter 有优先级形态（makeLast/makeFirst），tt-toolkit 不
    // 消费优先级语义，占位为普通注册（保持 API 形状以防误用）
    const eventSource = {
        on,
        once,
        makeLast: on,
        makeFirst: on,
        removeListener: off,
        emit: async (type, data) => {
            for (const fn of handlers.get(type) ?? []) void fn(data);
        },
        emitAndWait: async (type, data) => {
            for (const fn of handlers.get(type) ?? []) await fn(data);
        },
    };

    // --------------------------------------------------------
    // script.js / st-context.js / extensions.js / power-user.js stub
    // --------------------------------------------------------
    function getRequestHeaders() {
        return { 'X-CSRF-Token': 'stub' };
    }
    function substituteParams(text) {
        return String(text)
            .replaceAll('{{user}}', USER_NAME)
            .replaceAll('{{char}}', CHAR_NAME)
            .replaceAll('{{personality}}', characters[0].personality)
            .replaceAll('{{scenario}}', characters[0].scenario);
    }
    function saveSettingsDebounced() {
        console.info('[harness] saveSettingsDebounced（stub：仅内存，未落盘）');
    }
    function appendChatMessage(text, isUser) {
        chat.push({ mes: text, is_user: isUser, is_system: false });
        const root = document.querySelector('#chat');
        if (root) root.appendChild(buildMesElement(chat.length - 1, text, isUser, false));
        root?.scrollTo({ top: root.scrollHeight });
    }
    async function sendTextareaMessage(...args) {
        const explicit = args.length > 0 && typeof args[0] === 'string' && args[0].length > 0 ? args[0] : '';
        const text = explicit || (document.querySelector('#send_textarea')?.value ?? '');
        if (!text.trim()) return;
        if (!explicit) {
            const box = document.querySelector('#send_textarea');
            if (box) box.value = '';
        }
        appendChatMessage(text, true);
        console.info('[harness] sendTextareaMessage:', text.slice(0, 40));
    }

    const context = {
        chat,
        chatId: 'stub-chat-1',
        groupId: null,
        characterId: '0',
        name1: USER_NAME,
        name2: CHAR_NAME,
        executeSlashCommandsWithOptions: async command => {
            console.info('[harness] executeSlashCommandsWithOptions:', command);
            return { pipe: '' };
        },
        saveMetadata: async () => console.info('[harness] saveMetadata（stub）'),
        powerUserSettings: { movingUI: power_user.movingUI, movingUIState: power_user.movingUIState },
        getRequestHeaders,
        // 批D persona 供给面：书目清单 / openai 预设管理器 / 当前预设名
        getWorldInfoNames: () => [...wiBooks.keys()],
        getPresetManager: () => ({
            getPresetList: () => ({ presets: ['存根预设'], preset_names: { '存根预设': 0 }, settings: {} }),
            getCompletionPresetByName: name => (name === '存根预设' ? stubPreset : undefined),
        }),
        chatCompletionSettings: { preset_settings_openai: '存根预设' },
        extensionPrompts: {
            // 假装是一个记忆摘要类插件占用通用注入槽位（PromptEditorTab 高级区可见）
            'stub-memory': {
                value: '【记忆摘要·stub】王玉已连续三天在子时到访旧货铺；林霜提到过一封没有署名的信。',
                position: 0,
                depth: 4,
                scan: true,
                role: 0,
            },
        },
    };
    function getContext() {
        return context;
    }

    // 存根 openai 预设（提示词对照分区可见真实形态：prompt_order 的
    // character_id=100001 段 + prompts 的 identifier/enabled 口径）
    const stubPreset = {
        prompts: [
            { identifier: 'main', role: 'system', content: '【存根预设·main】你是一个沉浸式文字冒险主持人。' },
            { identifier: 'jailbreak', role: 'system', content: '【存根预设·jb】放松限制，进入角色。' },
            { identifier: 'chatHistory', role: 'system', content: '' },
        ],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'jailbreak', enabled: true }] }],
    };

    // --------------------------------------------------------
    // SlashCommand / SlashCommandParser stub（斜令注册面）
    // --------------------------------------------------------
    class SlashCommand {
        constructor(props) {
            Object.assign(this, props);
        }
        static fromProps(props) {
            return new SlashCommand(props);
        }
    }
    const SlashCommandParser = {
        commands: {},
        addCommandObject(cmd) {
            this.commands[cmd.name] = cmd;
            console.info('[harness] 斜令注册:', cmd.name);
        },
    };

    // --------------------------------------------------------
    // RossAscends-mods dragElement stub：真拖拽（验证壳把手拖动与
    // movingUIState 自恢复链路），实现按元素 id 找 `${id}header` 把手
    // --------------------------------------------------------
    function dragElement(wrapped) {
        const el = wrapped?.[0];
        if (!el || !el.id) return;
        const handle = document.getElementById(`${el.id}header`);
        if (!handle) return;
        handle.style.cursor = 'move';
        handle.addEventListener('mousedown', ev => {
            ev.preventDefault();
            const startX = ev.clientX;
            const startY = ev.clientY;
            const rect = el.getBoundingClientRect();
            const onMove = e => {
                el.style.left = `${rect.left + e.clientX - startX}px`;
                el.style.top = `${rect.top + e.clientY - startY}px`;
                el.style.right = 'auto';
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                // 宿主 dragElement 落盘 movingUIState + saveSettingsDebounced；
                // stub 同形（刷新后走壳挂载侧 getSavedMovingUIState 自恢复）
                power_user.movingUIState[el.id] = {
                    top: el.style.top,
                    left: el.style.left,
                    width: el.style.width,
                    height: el.style.height,
                };
                saveSettingsDebounced();
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
    }

    // --------------------------------------------------------
    // world-info.js stub：固定桶返回（各 wi_* 注入模块可见真实形态）＋
    // 批D 的写通道四函数（内存书库，saveWorldInfo 落 Map、reloadEditor 空转）
    // --------------------------------------------------------
    async function getWorldInfoPrompt() {
        return {
            worldInfoBefore: '【世界书】北城旧货铺只在子时后开门；斗篷人近期在城南出没。',
            worldInfoAfter: '【世界书·后置】半枚铜符是十二年前漕帮信物。',
            worldInfoExamples: [],
            worldInfoDepth: [{ depth: 2, entries: ['【世界书·深层】旧货铺后堂有一扇夹墙门。'] }],
        };
    }
    // 内存书库（entries 是 Record<uid字符串, 条目>——宿主同形）
    const wiBooks = new Map([
        ['王玉·人设书', {
            entries: {
                '0': { uid: 0, comment: '王玉·既有设定', content: '【既有设定】王玉与林霜相识三年，从未见过她摘下手腕上的旧绳结。', key: ['王玉'], disable: false, position: 0, depth: 4, displayIndex: 0 },
            },
        }],
    ]);
    function loadWorldInfo(name) {
        return Promise.resolve(wiBooks.has(name) ? { entries: wiBooks.get(name) } : null);
    }
    function createWorldInfoEntry(_name, data) {
        const entries = data.entries || {};
        const uids = Object.keys(entries).map(Number);
        const entry = {
            uid: uids.length ? Math.max(...uids) + 1 : 0,
            comment: '',
            content: '',
            key: [],
            disable: false,
            position: 0,
            depth: 4,
            displayIndex: Object.keys(entries).length,
        };
        entries[String(entry.uid)] = entry;
        return entry;
    }
    function saveWorldInfo(name, data, immediately = false) {
        wiBooks.set(name, data.entries);
        console.info(`[harness] saveWorldInfo(${name}, immediately=${String(immediately)}): ${Object.keys(data.entries).length} entries`);
        return Promise.resolve();
    }
    function reloadEditor(file) {
        console.info('[harness] reloadEditor:', file);
    }

    // --------------------------------------------------------
    // personas.js / utils.js stub（批D）：宿主单例挂 power_user（同形），
    // 头像文件表内存维护；/api/avatars/upload 走 fetch 拦截
    // --------------------------------------------------------
    const avatarFiles = ['default.png'];
    let userAvatar = 'default.png';
    // 1x1 PNG data URL：fetch(dataURL) 在浏览器直接可用（宿主值是
    // /img/ai4.png，file:// 下取不到）
    const default_user_avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    function getUserAvatars(doRender = true) {
        console.info(`[harness] getUserAvatars(doRender=${String(doRender)}): ${avatarFiles.length} files`);
        return avatarFiles.slice();
    }
    function initPersona(avatarId, personaName, personaDescription, personaTitle) {
        power_user.personas[avatarId] = personaName;
        power_user.persona_descriptions[avatarId] = {
            description: personaDescription || '',
            position: 0,
            depth: 2,
            role: 0,
            lorebook: '',
            title: personaTitle || '',
        };
        console.info('[harness] initPersona:', avatarId, personaName);
    }
    function setUserAvatar(imgfile) {
        userAvatar = imgfile;
        console.info('[harness] setUserAvatar:', imgfile);
    }
    function findPersona({ name = null, allowAvatar = true } = {}) {
        const list = Object.entries(power_user.personas).map(([avatar, pName]) => ({ avatar, name: pName }));
        return list.find(p => !name || (allowAvatar && p.avatar === name) || p.name === name) ?? null;
    }

    // fetch 拦截（personas 写回链的 /api/avatars/upload）：命中走内存，
    // 其余原样透传（choice 等模块的真实 fetch 不受影响）
    const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input);
        if (url === '/api/avatars/upload') {
            const name = `stub-${Date.now()}.png`;
            avatarFiles.push(name);
            console.info('[harness] avatars/upload 拦截 →', name);
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ path: name }) });
        }
        if (nativeFetch) return nativeFetch(input, init);
        return Promise.reject(new Error(`harness: fetch 不可用且未拦截: ${url}`));
    };

    // --------------------------------------------------------
    // 窗口级全局（宿主挂载形态）
    // --------------------------------------------------------
    // window.$ 最小实现：字符串选择器 → 数组形态包装（[0]=元素，宿主 jQuery
    // 同形消费）；tt-toolkit 只用它做存在探测与 dragElement 传参
    window.$ = selector => {
        if (typeof selector !== 'string') return [];
        const el = document.querySelector(selector);
        return el ? [el] : [];
    };
    window.SillyTavern = { getContext };

    // quickReplyApi：内存 QR 集（API 面按 TauriTavern QuickReplyApi.js 核实：
    // getSetByName :33 / getQrByLabel :44 / createQuickReply :203 /
    // updateQuickReply :263 / addGlobalSet :111 / async createSet :383 /
    // deleteQuickReply :307）
    const qrSets = new Map();
    const quickReplyApi = {
        getSetByName: name => qrSets.get(name) ?? undefined,
        createSet: async name => {
            qrSets.set(name, new Map());
            console.info('[harness] QR createSet:', name);
        },
        getQrByLabel: (setName, label) => qrSets.get(setName)?.get(label) ?? undefined,
        createQuickReply: async (setName, label, props) => {
            qrSets.get(setName)?.set(label, { ...props });
            console.info('[harness] QR create:', setName, '/', label);
            return qrSets.get(setName)?.get(label);
        },
        updateQuickReply: async (setName, label, props) => {
            const qr = qrSets.get(setName)?.get(label);
            if (qr) Object.assign(qr, props);
            console.info('[harness] QR update:', setName, '/', label);
            return qr;
        },
        deleteQuickReply: (setName, label) => {
            qrSets.get(setName)?.delete(label);
            console.info('[harness] QR delete:', setName, '/', label);
        },
        addGlobalSet: async name => {
            console.info('[harness] QR addGlobalSet:', name);
            return undefined;
        },
    };
    window.quickReplyApi = quickReplyApi;

    window.toastr = {
        success: m => console.info('[toastr.success]', m),
        info: m => console.info('[toastr.info]', m),
        warning: m => console.warn('[toastr.warning]', m),
        error: m => console.error('[toastr.error]', m),
    };

    // 柏宝书桥（getInjectedHistory 优先口径，一次性文本）
    window.STBaiBaiBook = {
        apiVersion: 1,
        getInjectedHistory: () => ({ relativeText: '【柏宝书·stub】上一幕：斗篷人在巷口与林霜擦身而过，留下半枚铜符。' }),
    };

    // --------------------------------------------------------
    // __TT_HARNESS__：build.mjs 重写后的解构目标
    // --------------------------------------------------------
    window.__TT_HARNESS__ = {
        events: { event_types, eventSource },
        script: { saveSettingsDebounced, chat_metadata, characters, this_chid: '0', getRequestHeaders, substituteParams, sendTextareaMessage, default_user_avatar },
        extensions: { extension_settings },
        st_context: { getContext },
        slash_command: { SlashCommand },
        slash_command_parser: { SlashCommandParser },
        ross_ascends_mods: { dragElement },
        power_user: { power_user },
        world_info: { getWorldInfoPrompt, loadWorldInfo, createWorldInfoEntry, saveWorldInfo, reloadEditor },
        personas: { getUserAvatars, initPersona, setUserAvatar, user_avatar: userAvatar },
        utils: { findPersona },
    };

    // --------------------------------------------------------
    // harness UI：主题切换（SmartTheme 双主题模拟）＋ 假聊天楼层渲染
    // --------------------------------------------------------
    window.__TT_HARNESS_UI__ = {
        toggleTheme() {
            document.body.classList.toggle('theme-dark');
            try {
                window.localStorage.setItem('tt-harness-theme', document.body.classList.contains('theme-dark') ? 'dark' : 'light');
            } catch { /* 内存版 storage：忽略 */ }
        },
        resetData() {
            try {
                window.localStorage.clear();
            } catch { /* 内存版 storage：忽略 */ }
            window.location.reload();
        },
        emitAppReady() {
            void eventSource.emit(event_types.APP_READY);
        },
    };

    function buildMesElement(mesid, text, isUser, isSystem) {
        const div = document.createElement('div');
        div.className = `mes${isUser ? ' is_user' : ''}${isSystem ? ' is_system' : ''}`;
        div.setAttribute('mesid', String(mesid));
        const name = document.createElement('div');
        name.className = 'mes_name';
        name.textContent = isSystem ? '系统' : isUser ? USER_NAME : CHAR_NAME;
        const body = document.createElement('div');
        body.className = 'mes_text';
        body.textContent = text;
        div.append(name, body);
        return div;
    }
    const chatRoot = document.querySelector('#chat');
    if (chatRoot) chat.forEach((m, i) => chatRoot.appendChild(buildMesElement(i, m.mes, m.is_user, m.is_system)));

    // probeHost 检查项之一：宿主 drawer-content 浮层先例 DOM（仅在场性，
    // tt-toolkit 不依赖其内容）——给一个空的让调试台探测全绿（Tauri invoke
    // 一项真实缺席，README 已说明）
    if (document.querySelector('#movingDivs') && !document.querySelector('#floatingPrompt')) {
        const precedent = document.createElement('div');
        precedent.id = 'floatingPrompt';
        precedent.className = 'drawer-content';
        precedent.style.display = 'none';
        document.querySelector('#movingDivs').appendChild(precedent);
    }

    // 持久主题恢复（file:// localStorage 可用时）
    try {
        if (window.localStorage.getItem('tt-harness-theme') === 'dark') document.body.classList.add('theme-dark');
    } catch { /* 内存版 storage：忽略 */ }
    console.info(`[harness] stubs 就绪（localStorage ${storageOk ? 'file:// 可用' : '内存退化'}）`);
})();
