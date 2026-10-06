/**
 * TT 宿主世界书通道（persona 的参考读取面＋绑定书读取）。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - world-info.js:2241 `export async function loadWorldInfo(name)`：按书名
 *   装载 {entries:{uid字符串:条目}}；书不存在返回 null。
 * - st-context.js:289 `getWorldInfoNames: () => [...world_names]`：全量
 *   书目快照（宿主启动时 updateWorldInfoList 装载），走 context 通道。
 * - 当前角色绑定书顺序：data.extensions.world（主书必须排内嵌书之前）
 *   → data.character_book.name → data.world → chat_metadata.world_info。
 */

import { loadWorldInfo } from '@sillytavern/scripts/world-info';
import { currentCharacterData } from './characters';
import { currentChatMetadata } from './settings';
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

/** 读取对象上的字符串字段。 */
function strField(obj: Record<string, unknown> | undefined, key: string): string {
    const v = obj?.[key];
    return typeof v === 'string' ? v : '';
}

/**
 * 当前聊天绑定的世界书（有序去重；主书必须排内嵌书之前——顺序即优先级）。
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
    const chatBook = currentChatMetadata().world_info;
    if (typeof chatBook === 'string' && chatBook) books.add(chatBook);
    return Array.from(books).filter(Boolean);
}
