/**
 * 存储调试设施（写读 roundtrip 机判＋三域 dump）——只服务冒烟与排障，
 * 不进 storage 服务公开面（消费方仅 main.ts 冒烟分支与 __TT_TOOLKIT__
 * 排障口）。
 */

import { writeChatMetadata, writeExtensionSettings } from '@/host';
import { CHAT_KEY, GLOBAL_KEY, getChat, getGlobal, readChatDomain, readGlobalDomain, setChat, setGlobal } from './service';
import { newId } from './id';

export interface RoundtripReport {
    scope: 'global' | 'chat';
    ok: boolean;
    written: string;
    readBack: string;
    at: string;
}

const SMOKE_KEY = '_smoke';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * storage 写读 roundtrip：全局域与聊天域各写一个随机 token 再读回比对。
 * 读回走同一读取路径（getGlobal/getChat），链路＝用户实际数据链路。
 * 比对完成后经正式变更器删除 _smoke 键——测试残留会随用户数据落盘
 * 并出现在调试 dump 里。
 */
export function runStorageRoundtrip(): RoundtripReport[] {
    const reports: RoundtripReport[] = [];

    const globalToken = newId('rt');
    setGlobal(SMOKE_KEY, { token: globalToken });
    const globalRead = getGlobal<{ token: string }>(SMOKE_KEY)?.token;
    reports.push({
        scope: 'global',
        ok: globalRead === globalToken,
        written: globalToken,
        readBack: String(globalRead),
        at: new Date().toISOString(),
    });

    const chatToken = newId('rt');
    setChat(SMOKE_KEY, { token: chatToken });
    const chatRead = getChat<{ token: string }>(SMOKE_KEY)?.token;
    reports.push({
        scope: 'chat',
        ok: chatRead === chatToken,
        written: chatToken,
        readBack: String(chatRead),
        at: new Date().toISOString(),
    });

    writeExtensionSettings(settings => {
        const domain = settings[GLOBAL_KEY];
        if (isRecord(domain)) delete domain[SMOKE_KEY];
    });
    writeChatMetadata(metadata => {
        const domain = metadata[CHAT_KEY];
        if (isRecord(domain)) delete domain[SMOKE_KEY];
    });

    return reports;
}

/**
 * 存储三域快照序列化（调试 dump 用）。
 * 密钥掩码（双复核 P3）：调试面板不回显明文——choice.apis[].key 只保留
 * 前 6 字符＋省略号（判断「填没填、填的是哪把」足够，整把钥匙不进 DOM）。
 */
export function dumpStorage(): string {
    const maskedGlobal = JSON.stringify(readGlobalDomain(), null, 2)
        ?.replace(/("key"\s*:\s*")([^"]*)(")/g, (_m, p1: string, val: string, p3: string) =>
            val ? `${p1}${val.slice(0, 6)}…${p3}` : `${p1}${val}${p3}`)
        ?? '';
    const lines = [
        `storage dump @ ${new Date().toISOString()}`,
        `global(${GLOBAL_KEY}) = ${maskedGlobal}`,
        `chat(${CHAT_KEY}) = ${JSON.stringify(readChatDomain(), null, 2)}`,
    ];
    return lines.join('\n');
}
