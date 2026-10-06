/**
 * TT 宿主世界书通道（persona 的参考/写回数据面＋绑定书读取）。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - world-info.js:2241 `export async function loadWorldInfo(name)`：按书名
 *   装载 {entries:{uid字符串:条目}}；书不存在返回 null。
 * - world-info.js:4295 `createWorldInfoEntry(_name, data)`：书内新建条目
 *   （宿主负责 uid 分配与字段模板），null=uid 分配失败。
 * - world-info.js:4362 `saveWorldInfo(name, data, immediately=false)`：
 *   immediately 必须 true——漏 true 会「保存后读回为空」（防抖队列里被
 *   后续装载覆盖）；true 时 await 返回即宿主已确认 HTTP 落盘。
 * - world-info.js:1144 `reloadEditor(file, loadIfNotSelected=false)`：刷新
 *   世界书编辑器视图（编辑器开着才刷新，内部自判；不刷会导致
 *   「存上了但界面没变」）。
 * - st-context.js:289 `getWorldInfoNames: () => [...world_names]`：全量
 *   书目快照（宿主启动时 updateWorldInfoList 装载），走 context 通道。
 * - 当前角色绑定书顺序（写回取首本）：data.extensions.world（主书必须
 *   排内嵌书之前）→ data.character_book.name → data.world →
 *   chat_metadata.world_info。
 */

import { createWorldInfoEntry, loadWorldInfo, reloadEditor, saveWorldInfo } from '@sillytavern/scripts/world-info';
import type { WorldInfoEntryHost } from '@sillytavern/scripts/world-info';
import { chat_metadata, characters, this_chid } from './settings';
import { createTtlog } from './ttlog';

const log = createTtlog('host/worldinfo');

/** 世界书条目的消费视图（原生命令口径：key 是数组、disable 是反向布尔）。 */
export interface WorldBookEntrySummary {
    uid: number;
    displayName: string;
    content: string;
    enabled: boolean;
    depth: number;
    position: number | 'unknown';
}

/** 宿主世界书数据（写通道按引用改 entries 后整本回写）。 */
export interface WorldInfoBookData {
    entries: Record<string, WorldInfoEntryHost>;
}

/** 按书名装载世界书数据（null=书不存在或宿主通道异常）。 */
export async function loadWorldInfoBook(bookName: string): Promise<WorldInfoBookData | null> {
    return await loadWorldInfo(bookName);
}

/**
 * 单书条目读取（失败返回空表不阻断其余书目——消费方按空书处理）。
 */
export async function getWorldBookEntries(bookName: string): Promise<WorldBookEntrySummary[]> {
    try {
        const data = await loadWorldInfo(bookName);
        if (!data) return [];
        return Object.values(data.entries || {}).map(e => ({
            uid: Number(e.uid) || 0,
            displayName: e.comment || (Array.isArray(e.key) ? e.key.join(', ') : String(e.key ?? '')) || '无标题',
            content: typeof e.content === 'string' ? e.content : '',
            enabled: !e.disable,
            depth: typeof e.depth === 'number' ? e.depth : 0,
            position: typeof e.position === 'number' ? e.position : 'unknown',
        }));
    } catch (err) {
        log.warn('世界书条目装载失败', { bookName, err });
        return [];
    }
}

/** 当前角色数据（v2 char.data / v1 char 统一口径；未选角色返回 null）。 */
function currentCharacterData(): Record<string, unknown> | null {
    const chid = Number(this_chid);
    if (!Number.isInteger(chid) || chid < 0) return null;
    const char = characters[chid] as Record<string, unknown> | undefined;
    if (!char || typeof char !== 'object') return null;
    const data = char.data;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : char;
}

/** 读取对象上的字符串字段。 */
function strField(obj: Record<string, unknown> | undefined, key: string): string {
    const v = obj?.[key];
    return typeof v === 'string' ? v : '';
}

/**
 * 当前聊天绑定的世界书（有序去重；主书必须排内嵌书之前——写回取首本）。
 */
export function getContextWorldBooks(): string[] {
    const books = new Set<string>();
    const data = currentCharacterData();
    if (data) {
        const extensions = data.extensions as Record<string, unknown> | undefined;
        const charBook = data.character_book as Record<string, unknown> | undefined;
        for (const name of [strField(extensions, 'world'), strField(charBook, 'name'), strField(data, 'world')]) {
            if (name) books.add(name);
        }
    }
    const chatBook = (chat_metadata as Record<string, unknown>).world_info;
    if (typeof chatBook === 'string' && chatBook) books.add(chatBook);
    return Array.from(books).filter(Boolean);
}

/**
 * 人设条目写回世界书（PersonaWeaver fork 平移的写通道）：
 * 读全量 → 定位/新建指定 comment 的条目 → saveWorldInfo(immediately=true)
 * 整本回写 → reloadEditor。原生条目字段口径：key 是数组、disable 是反向
 * 布尔（与旧依赖的 keys/enabled 语义不同，映射反了＝条目静默失效）。
 * 失败抛错（成败即真判据：immediately=true 时 await 返回即已落盘，链上
 * 再无用户代码）；toast 归调用方。
 */
export async function upsertWorldInfoPersonaEntry(
    bookName: string,
    entryTitle: string,
    content: string,
    entryKeys: string[],
): Promise<void> {
    const data = await loadWorldInfo(bookName);
    if (!data) throw new Error(`世界书不存在: ${bookName}`);
    const entries = Object.values(data.entries || {});
    const existingEntry = entries.find(e => e.comment === entryTitle);

    if (existingEntry) {
        existingEntry.content = content;
        existingEntry.key = entryKeys;
        existingEntry.disable = false;
    } else {
        // 条目创建走宿主正规 helper（uid 分配＋字段模板由宿主维护）；
        // 模板不含 displayIndex，自设 max+1 保证编辑器排序稳定（宿主排序回退 uid）
        const entry = createWorldInfoEntry(bookName, data);
        if (!entry) throw new Error('无法为新条目分配 uid');
        entry.comment = entryTitle;
        entry.content = content;
        entry.key = entryKeys;
        entry.displayIndex = entries.reduce((m, e) => Math.max(m, Number(e.displayIndex) || 0), -1) + 1;
    }
    await saveWorldInfo(bookName, data, true);
    reloadEditor(bookName);
}
