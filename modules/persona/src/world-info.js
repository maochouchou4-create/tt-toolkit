// 世界书域：绑定书目发现、条目读取、勾选持久化、人设写回世界书、
// 智能关键词抽取与跨角色钉选。WI 专属持久化归本模块；键常量的
// 单一事实源在 state.js，经 import 消费。
// 宿主模块 import（4 段上溯已落在宿主 scripts/ 目录内，specifier 不带 scripts/ 段）；
// 白名单见 scripts/check-imports.mjs 的 EXTERNAL。
import { getContext } from "../../../../../../extensions.js";
import { saveSettingsDebounced, default_user_avatar, getRequestHeaders } from "../../../../../../../script.js";
import { findPersona } from "../../../../../../utils.js";
import { initPersona, setUserAvatar, getUserAvatars, user_avatar } from "../../../../../../personas.js";
import { power_user } from "../../../../../../power-user.js";
import { createWorldInfoEntry, reloadEditor } from "../../../../../../world-info.js";
import { getCurrentCharacterData } from "./st-data.js";
import { store, safeLocalStorageSet, STORAGE_KEY_WI_STATE, STORAGE_KEY_PINNED_BOOKS } from "./state.js";
import { TEXT } from "./strings.js";
import { error as logError, warn as logWarn } from "./log.js";

// 钉选书目装载：pinned 为持久层，extra＝pinned＋会话内手动追加（消费方一律走 getAllWorldBooks 合并）
try { store.pinnedBooks = JSON.parse(localStorage.getItem(STORAGE_KEY_PINNED_BOOKS)) || []; } catch { store.pinnedBooks = []; }
store.extraBooks = [...store.pinnedBooks];

export function getPosAbbr(pos) {
    // 原生数字枚举（TauriTavern world-info.js：0 角色前/1 角色后/2 AN前/3 AN后/4 @深度/5 样例前/6 样例后）
    return ({ 0: 'PreChar', 1: 'PostChar', 2: 'PreAN', 3: 'PostAN', 4: '@Depth', 5: 'PreEx', 6: 'PostEx' })[pos] ?? '?';
}

function getWiCacheKey() {
    const context = getContext();
    return context.characterId || 'global_no_char'; 
}

export function loadWiSelection(bookName) {
    const charKey = getWiCacheKey();
    if (store.wiSelectionCache[charKey] && store.wiSelectionCache[charKey][bookName]) {
        return store.wiSelectionCache[charKey][bookName]; 
    }
    return null;
}

export function saveWiSelection(bookName, uids) {
    const charKey = getWiCacheKey();
    if (!store.wiSelectionCache[charKey]) store.wiSelectionCache[charKey] = {};
    store.wiSelectionCache[charKey][bookName] = uids;
    safeLocalStorageSet(STORAGE_KEY_WI_STATE, JSON.stringify(store.wiSelectionCache));
}

// 人设写回（TT 正规口径）：personas 真源是 {头像文件id: 显示名}，描述在
// persona_descriptions[头像id].description，持久化时由后端写进头像 PNG 元数据——
// 头像文件不存在即报「no longer exists」，故新人设必须先经 /api/avatars/upload 落 PNG。
// persona_selected 字段在 TT 不存在，选中态走 setUserAvatar（user_avatar）。
export async function upsertPersona(displayName, description) {
    // 先清假键再查重：旧版插件写入的幽灵键若仍在内存，findPersona 会命中它并走
    // 「更新已存在」分支——该分支对无头像文件的 id 必然保存失败
    await cleanGhostPersonaKeys();
    const existing = findPersona({ name: displayName, allowAvatar: false, preferCurrentPersona: false });
    const avatarId = existing?.avatar ?? await createAvatarPersona(displayName, description);

    if (existing) {
        // 按名查到的人设名字本就一致，此处不写 name（半截改名会与 name1 脱钩，改名应走宿主流程）
        const descriptor = power_user.persona_descriptions[avatarId] ??=
            { position: 0, depth: 2, role: 0, lorebook: '', title: '' };
        descriptor.description = description;
        if (user_avatar === avatarId) {
            // 改的是当前选中人设：setUserAvatar 对同人设会早退、宿主无人监听 PERSONA_UPDATED，
            // 镜像与宿主描述框必须手动刷——描述框是宿主权威编辑面，旧值会被其 input 回写进 descriptor
            power_user.persona_description = description;
            $('#persona_description').val(description);
        }
        saveSettingsDebounced();
        const context = getContext();
        await context.eventSource.emit(context.eventTypes.PERSONA_UPDATED, avatarId);
    }
    // 应用＝该人设成为当前人设；跨人设切换时 setUserAvatar 内部的 selectCurrentPersona
    // 会同步 name1、单数镜像与描述框 DOM；同人设已在上方手动刷过
    if (user_avatar !== avatarId) await setUserAvatar(avatarId, { toastPersonaNameChange: false });
}

// 新人设创建：上传默认头像 PNG（人设持久化载体，文件不存在即「no longer exists」）
// → initPersona 写 name 与描述 descriptor。返回落盘的 avatarId（以上传响应为准）。
async function createAvatarPersona(displayName, description) {
    const preferredId = `${Date.now()}-${displayName.replace(/[^a-zA-Z0-9]/g, '')}.png`; // 约定照抄宿主 createDummyPersona
    const blob = await (await fetch(default_user_avatar)).blob();
    const form = new FormData();
    form.append('avatar', new File([blob], 'avatar.png', { type: 'image/png' }));
    form.append('overwrite_name', preferredId);
    const res = await fetch('/api/avatars/upload', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: form,
    });
    if (!res.ok) throw new Error(`头像上传失败 (${res.status})`);
    const avatarId = (await res.json()).path || preferredId;
    await getUserAvatars(false);
    await initPersona(avatarId, displayName, description, '', { silent: true });
    return avatarId;
}

// 清理 personas 里指向不存在头像文件的假键（旧版插件写入的脏数据；纯内存删除＋存盘，
// 禁止对这些 id 调 /persona-delete——后端对不存在文件 404）。
async function cleanGhostPersonaKeys() {
    try {
        const files = new Set(await getUserAvatars(false));
        if (files.size === 0) return; // 磁盘快照为空的异常态，宁漏勿误删
        let removed = false;
        for (const id of Object.keys(power_user.personas)) {
            if (!files.has(id)) {
                delete power_user.personas[id];
                delete power_user.persona_descriptions[id];
                removed = true;
            }
        }
        if (removed) saveSettingsDebounced();
    } catch (e) {
        logWarn("清理人设假键失败:", e);
    }
}

export function generateSmartKeywords(name, content, staticTags = []) {
    let rawKeys = [name, ...staticTags];

    // 1. 尝试从内容中提取 "别名/昵称/Alias"
    const aliasMatch = content.match(/(?:别名|昵称|Alias)[:：]\s*(.*?)(\n|$)/i);
    if (aliasMatch) {
        // 支持中文逗号、英文逗号、顿号分隔
        const aliases = aliasMatch[1].split(/[,，、]/).map(s => s.trim()).filter(s => s);
        rawKeys.push(...aliases);
    }

    // 2. 智能拆分 (针对翻译名或西文名)
    if (name.includes('·')) {
        // 如 "希尔薇·波拉" -> 添加 "希尔薇"
        rawKeys.push(name.split('·')[0].trim());
    } else if (name.includes(' ')) {
        // 如 "John Doe" -> 添加 "John" (防止单字母触发)
        const firstName = name.split(' ')[0].trim();
        if (firstName.length > 1) rawKeys.push(firstName);
    }

    // 3. 去重、过滤短词(长度<=1)、移除空值
    return [...new Set(rawKeys)].filter(k => k && k.length > 1);
}

// 人设写回世界书：读全量 → 定位/新建 USER 条目 → saveWorldInfo(immediately=true) 整本回写。
// immediately=true 时 await 返回即宿主已确认 HTTP 落盘，链上再无用户代码——成败即真判据，
// 不再有「写入成功却报失败」的中间抛错面（旧依赖链的 catch-all 误报根因）。
export async function syncPersonaToWorldInfo(userName, content) {
    const targetBook = (await getContextWorldBooks())[0];
    if (!targetBook) return toastr.warning(TEXT.TOAST_WI_FAIL);

    const nameMatch = content.match(/姓名:\s*(.*?)(\n|$)/);
    const finalUserName = nameMatch ? nameMatch[1].trim() : (userName || "User");
    const entryTitle = `USER:${finalUserName}`;
    const entryKeys = generateSmartKeywords(finalUserName, content, ["User"]);

    try {
        const data = await getContext().loadWorldInfo(targetBook);
        const entries = Object.values(data.entries || {});
        const existingEntry = entries.find(e => e.comment === entryTitle);

        if (existingEntry) {
            // 原生条目字段：key 是数组、disable 是反向布尔（与旧依赖的 keys/enabled 语义不同，映射反了＝条目静默失效）
            existingEntry.content = content;
            existingEntry.key = entryKeys;
            existingEntry.disable = false;
        } else {
            // 条目创建走宿主正规 helper（uid 分配＋字段模板由宿主维护，宿主升级零跟进）；
            // 模板不含 displayIndex，自设 max+1 保证编辑器排序稳定（宿主排序回退 uid，:2394）
            const entry = createWorldInfoEntry(targetBook, data);
            if (!entry) throw new Error("无法为新条目分配 uid");
            entry.comment = entryTitle;
            entry.content = content;
            entry.key = entryKeys;
            entry.displayIndex = entries.reduce((m, e) => Math.max(m, Number(e.displayIndex) || 0), -1) + 1;
        }
        await getContext().saveWorldInfo(targetBook, data, true);
        reloadEditor(targetBook); // 编辑器开着才刷新，内部自判；不刷会导致「存上了但界面没变」
        toastr.success(TEXT.TOAST_WI_SUCCESS(targetBook, entryTitle) + `\n触发词: ${entryKeys.join(', ')}`);
    } catch (e) {
        logError("World Info Sync Error:", e);
        toastr.error(TEXT.TOAST_WI_WRITE_FAIL + e.message);
    }
}

export async function loadAvailableWorldBooks() {
    // 单一事实源＝宿主启动时 updateWorldInfoList 装载的全量书目快照
    store.availableWorldBooks = getContext().getWorldInfoNames();
    store.availableWorldBooks = [...new Set(store.availableWorldBooks)].filter(x => x).sort();
}

export async function getContextWorldBooks() {
    const context = getContext();
    const books = new Set();
    const data = getCurrentCharacterData();
    if (data) {
        // 主书（extensions.world）必须排在内嵌书之前——写回世界书取首个绑定书
        if (data.extensions?.world) books.add(data.extensions.world);
        if (data.character_book?.name) books.add(data.character_book.name);
        if (data.world) books.add(data.world);
        if (context.chatMetadata?.world_info) books.add(context.chatMetadata.world_info);
    }
    return Array.from(books).filter(Boolean);
}

export async function getWorldBookEntries(bookName) {
    try {
        const data = await getContext().loadWorldInfo(bookName);
        return Object.values(data.entries || {}).map(e => ({
            uid: e.uid,
            displayName: e.comment || (Array.isArray(e.key) ? e.key.join(', ') : e.key) || "无标题",
            content: e.content || "",
            enabled: !e.disable,
            depth: e.depth ?? 0,
            position: e.position ?? 'unknown'
        }));
    } catch (e) {
        // 单书读取失败（不存在/宿主异常）不阻断其余书目，消费方按空书处理
        logWarn("Failed to load world book entries:", bookName, e);
        return [];
    }
}

export function savePinnedBooks() {
    try { localStorage.setItem(STORAGE_KEY_PINNED_BOOKS, JSON.stringify(store.pinnedBooks)); } catch(e) { logWarn(e); }
}

// 全量书目＝绑定书＋手动追加书，去重后的单一合并口（生成取数／载入选择器／下拉渲染共用）。
export async function getAllWorldBooks() {
    return [...new Set([...(await getContextWorldBooks()), ...store.extraBooks])];
}
