/**
 * 外部注入搬运（方案 §2.3 可选模块，默认关）。
 *
 * 两条通道（独立 API 旁路请求的真实代价——酒馆的注入不会自动进旁路
 * 请求，外部内容逐条自接）：
 *   ①宿主通用注入槽位：extension_prompts 表经 context 暴露
 *     （st-context.js:158）——对标准记忆/摘要类插件通用。扫槽位列出
 *     占用项＋内容预览，用户勾选搬入（不偷塞别家内容）。
 *   ②柏宝书 STBaiBaiBook 私有 API：globalThis.STBaiBaiBook 版本化契约
 *     （apiVersion/capabilities）。取数纪律：每次组装前现取（不启动时
 *     缓存，插件可能后加载/切卡重建 API）、优先注入口径
 *     （getInjectedHistory）、降级全量历史（getHistory）、缺席返回
 *     null 静默（第三方桥接必须可选，不可用时主体功能不受影响）。
 */
import type { ExtensionPromptSlot } from '@/host';
import { getChatMessages, listExtensionPromptSlots } from '@/host';

/** 柏宝书对外 API 形态（取数纪律见文件头；字段面按消费最小集声明）。 */
interface BaiBaiBookApi {
    apiVersion?: number;
    getInjectedHistory?: () => { relativeText?: string } | null;
    getHistory?: (options: { before: number }) => { relativeText?: string } | null;
}

interface BaiBaiBookWindow {
    STBaiBaiBook?: BaiBaiBookApi;
}

function getBaiBaiApi(): BaiBaiBookApi | null {
    const w = globalThis as unknown as BaiBaiBookWindow;
    return w.STBaiBaiBook ?? null;
}

/**
 * 柏宝书摘要文本：优先注入口径（getInjectedHistory——与正常记忆注入
 * 同规则），降级全量历史（getHistory 截止最新楼）。任一命中返回文本，
 * 插件缺席/接口异常静默返回 null（可选桥接纪律）。
 */
export function getBaibaiSummary(): string | null {
    const api = getBaiBaiApi();
    if (!api) return null;
    try {
        const injected = api.getInjectedHistory?.();
        if (injected?.relativeText) return injected.relativeText;
        const chatLength = getChatMessages().length;
        if (api.getHistory && chatLength > 0) {
            const hist = api.getHistory({ before: chatLength });
            if (hist?.relativeText) return hist.relativeText;
        }
    } catch {
        // 第三方插件接口异常＝桥接不可用，静默降级（不留错误刷屏）
        return null;
    }
    return null;
}

/** 槽位占用项的可视化清单（设置界面：列出 key＋内容预览供用户勾选）。 */
export interface SlotPreview {
    key: string;
    preview: string;
    depth: number;
    position: number;
}

/** 扫描宿主通用注入槽位并生成预览（当前在场的占用项全量列出）。 */
export function listSlotPreviews(): SlotPreview[] {
    const slots: ExtensionPromptSlot[] = listExtensionPromptSlots();
    return slots.map(s => ({
        key: s.key,
        preview: s.value.length > 120 ? `${s.value.slice(0, 120)}…` : s.value,
        depth: s.depth,
        position: s.position,
    }));
}
