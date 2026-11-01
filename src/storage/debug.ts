/**
 * 存储调试设施（写读 roundtrip 机判＋全局域 dump）——只服务冒烟与排障，
 * 不进 storage 服务公开面（消费方仅 main.ts 冒烟分支与 __TT_TOOLKIT__
 * 排障口）。
 */

import { writeExtensionSettings } from '@/host';
import { GLOBAL_KEY, getGlobal, readGlobalDomain, setGlobal } from './service';
import type { GlobalDomain } from './service';
import { newId } from './id';
import { isRecord } from './shape';

export interface RoundtripReport {
    scope: 'global';
    ok: boolean;
    written: string;
    readBack: string;
    at: string;
}

// 测试探针键：非功能域不入域登记，断言处显式豁免（写读后即删、不落用户数据形状）
const SMOKE_GLOBAL_KEY = '_smoke' as keyof GlobalDomain;

/**
 * 探针读写口：探针键不在域登记面里（登记面只登记在用的子域），因此键挂上
 * 之后值形状无处可查——由本文件的 ProbeValue 自持，并在这一层一次性断言，
 * 免得断言散落四处（域登记门管的是在用子域的键，探针不归它管）。
 */
type ProbeValue = { token: string };

function writeGlobalProbe(value: ProbeValue): void {
    setGlobal(SMOKE_GLOBAL_KEY, value as unknown as GlobalDomain[keyof GlobalDomain]);
}

function readGlobalProbe(): string | undefined {
    return (getGlobal(SMOKE_GLOBAL_KEY) as unknown as ProbeValue | undefined)?.token;
}

/**
 * storage 写读 roundtrip：全局域写一个随机 token 再读回比对。
 * 读回走同一读取路径（getGlobal），链路＝用户实际数据链路。
 * 比对完成后经正式变更器删除 _smoke 键——测试残留会随用户数据落盘
 * 并出现在调试 dump 里。
 */
export function runStorageRoundtrip(): RoundtripReport[] {
    const reports: RoundtripReport[] = [];

    const globalToken = newId('rt');
    writeGlobalProbe({ token: globalToken });
    const globalRead = readGlobalProbe();
    reports.push({
        scope: 'global',
        ok: globalRead === globalToken,
        written: globalToken,
        readBack: String(globalRead),
        at: new Date().toISOString(),
    });

    writeExtensionSettings(settings => {
        const domain = settings[GLOBAL_KEY];
        if (isRecord(domain)) delete domain[SMOKE_GLOBAL_KEY];
    });

    return reports;
}

/**
 * 存储全局域快照序列化（调试 dump 用）。
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
    ];
    return lines.join('\n');
}
