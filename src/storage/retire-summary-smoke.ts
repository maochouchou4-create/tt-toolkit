/**
 * 总结域退役清理的烟雾机判（批 A 自 retire-summary.ts 拆出，纯搬移；
 * node 冒烟；沿用 [wipe-smoke] 标签，与 legacy-wipe 同属启动期存储清理段，
 * 由 scripts/smoke.mjs 的清理段计数单点机判）。
 * 判别式用「种进去再删」而不是「读一遍看缺席」——空档恒缺席，只看缺席的
 * 断言在清理整段没接线时照样绿。
 *
 * 独立成件不经 storage 桶导出（同 legacy-wipe-smoke：桶在入口静态图上，
 * smoke 名经桶即回流浏览器加载面；消费方 src/node-smoke.ts 直取）。
 */
import { currentChatMetadata, extension_settings } from '@/host';
import { CHAT_KEY, GLOBAL_KEY, readChatDomain, readGlobalDomain } from './service';
import { isRecord } from './shape';
import { hasRetiredKey, RETIRED_KEY, retireSummaryKeys } from './retire-summary';

const retireFailures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
    console.info(`[wipe-smoke] ${ok ? 'PASS' : 'FAIL'} 退役清理 ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) retireFailures.push(label);
}

/** 场景种子（形状对齐退役前的两处域值；值仅作在场证据，不参与断言）。 */
function seedRetiredKeys(): void {
    const settings = extension_settings as Record<string, unknown>;
    const globalDomain = (isRecord(settings[GLOBAL_KEY]) ? settings[GLOBAL_KEY] : {}) as Record<string, unknown>;
    globalDomain[RETIRED_KEY] = { autoEnabled: true, intervalRounds: 3, keepRounds: 3, bigEvery: 3 };
    settings[GLOBAL_KEY] = globalDomain;
    const metadata = currentChatMetadata();
    const chatDomain = (isRecord(metadata[CHAT_KEY]) ? metadata[CHAT_KEY] : {}) as Record<string, unknown>;
    chatDomain[RETIRED_KEY] = { bigSummary: '旧摘要正文', smallSummaries: [{ text: '旧摘要', fromFloor: 0, toFloor: 3 }] };
    metadata[CHAT_KEY] = chatDomain;
}

export function runRetireSummarySmoke(): void {
    console.info('=== 总结域退役清理机判 ===');

    seedRetiredKeys();
    const report = retireSummaryKeys();
    check('全局域退役键删除后缺席', report.globalRemoved && !hasRetiredKey(readGlobalDomain()));
    check('聊天域退役键删除后缺席', report.chatRemoved && !hasRetiredKey(readChatDomain()));

    const rerun = retireSummaryKeys();
    check('二跑幂等（键缺席不删不炸）', !rerun.globalRemoved && !rerun.chatRemoved);

    // 失败形态：域对象冻住（delete 抛 TypeError）→ 只 warn、启动链继续。
    // 换装的是同一槽位的替身对象，跑完即换回原引用，不动真实域内容。
    const settings = extension_settings as Record<string, unknown>;
    const originalDomain = settings[GLOBAL_KEY];
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    let threw = false;
    try {
        settings[GLOBAL_KEY] = Object.freeze({ [RETIRED_KEY]: { autoEnabled: true } });
        console.warn = (...args: unknown[]) => { warnings.push(args); };
        try {
            retireSummaryKeys();
        } catch {
            threw = true;
        }
    } finally {
        console.warn = originalWarn;
        settings[GLOBAL_KEY] = originalDomain;
    }
    check('删键抛错只 warn 不中断启动', !threw && warnings.length === 1, `warn ${warnings.length} 条`);

    if (retireFailures.length > 0) {
        console.error(`[wipe-smoke] FAIL：退役清理 ${retireFailures.length} 项未过：${retireFailures.join('；')}`);
        process.exitCode = 1;
        return;
    }
    console.info('[wipe-smoke] OK：退役清理（两域键删除后缺席＋二跑幂等＋失败仅 warn）全部通过。');
}
