/**
 * PersonaWeaver fork 世界书写侧编排（模块层）。
 *
 * 宿主读写通道在 host/worldinfo.ts（upsertWorldInfoPersonaEntry：读全量
 * → 定位/新建条目 → saveWorldInfo(immediately=true) 整本回写 →
 * reloadEditor）；本文件承载编排语义：目标书选择（角色绑定首本）、
 * 条目标题（USER:姓名）、触发词智能提取。
 *
 * MODIFICATIONS：旧版 toast/错误文案在调用方（store）——本层成败以
 * 返回值/异常表达（fail-fast，不吞错）。
 */

import { getContextWorldBooks, getWorldBookEntries, upsertWorldInfoPersonaEntry, type WorldBookEntrySummary } from '@/host';

/**
 * 触发词智能提取（旧 generateSmartKeywords 平移，纯函数）：
 * 姓名 + 静态标签 +「别名/昵称/Alias」行 + 翻译名/西文名拆分（'·' 取
 * 前段、空格取首名且长度>1），去重并滤除长度≤1 的短词（防误触发）。
 */
export function generateSmartKeywords(name: string, content: string, staticTags: string[] = []): string[] {
    const rawKeys = [name, ...staticTags];

    // 1. 尝试从内容中提取「别名/昵称/Alias」行（支持中英文逗号、顿号分隔）
    const aliasMatch = content.match(/(?:别名|昵称|Alias)[:：]\s*(.*?)(\n|$)/i);
    if (aliasMatch) {
        const aliases = aliasMatch[1].split(/[,，、]/).map(s => s.trim()).filter(s => s);
        rawKeys.push(...aliases);
    }

    // 2. 智能拆分（针对翻译名或西文名）
    if (name.includes('·')) {
        // 如「希尔薇·波拉」→ 追加「希尔薇」
        rawKeys.push(name.split('·')[0].trim());
    } else if (name.includes(' ')) {
        // 如「John Doe」→ 追加「John」（防止单字母触发）
        const firstName = name.split(' ')[0].trim();
        if (firstName.length > 1) rawKeys.push(firstName);
    }

    // 3. 去重、滤短词（长度≤1）、移除空值
    return [...new Set(rawKeys)].filter(k => k && k.length > 1);
}

/** 人设写世界书的结果面（调用方 toast 用）。 */
export interface WorldInfoSyncResult {
    book: string;
    entryTitle: string;
    keywords: string[];
}

/**
 * 人设写回世界书（旧 syncPersonaToWorldInfo 平移）：目标书＝当前角色
 * 绑定书的首本（无绑定书抛错）；条目标题＝`USER:姓名`（姓名从 YAML
 * 内容「姓名:」行提取，兜底传入用户名）；触发词＝智能提取 + "User"。
 */
export async function syncPersonaToWorldInfo(userName: string, content: string): Promise<WorldInfoSyncResult> {
    const targetBook = getContextWorldBooks()[0];
    if (!targetBook) throw new Error('当前角色未绑定世界书，无法写入');

    const nameMatch = content.match(/姓名:\s*(.*?)(\n|$)/);
    const finalUserName = nameMatch ? nameMatch[1].trim() : (userName || 'User');
    const entryTitle = `USER:${finalUserName}`;
    const entryKeys = generateSmartKeywords(finalUserName, content, ['User']);

    await upsertWorldInfoPersonaEntry(targetBook, entryTitle, content, entryKeys);
    return { book: targetBook, entryTitle, keywords: entryKeys };
}

/**
 * 世界书条目载入候选（旧「载入遮罩」的数据面）：全量书目条目，按用户名
 * 关键字过滤（条目标题/触发词含用户名即命中；用户名为空返回全量——
 * 调用方 UI 自行提示）。单书失败跳过不阻断。
 */
export async function listWorldBookEntriesForLoad(userName: string): Promise<Array<{ book: string; entry: WorldBookEntrySummary }>> {
    const books = getContextWorldBooks();
    const out: Array<{ book: string; entry: WorldBookEntrySummary }> = [];
    const keyword = userName.trim();
    for (const book of books) {
        const entries = await getWorldBookEntries(book);
        for (const entry of entries) {
            if (!keyword || entry.displayName.includes(keyword) || String(entry.uid) === keyword) {
                out.push({ book, entry });
            }
        }
    }
    return out;
}
