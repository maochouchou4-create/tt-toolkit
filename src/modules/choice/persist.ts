/**
 * 选项消息级落盘：读写「当前楼层」的 message.extra.ttToolkit.choice。
 *
 * 归属判据：选项是单条 AI 楼层的派生数据，与该楼正文同生命周期——宿主
 * swipe（extra 整体替换，script.js:8597）与删楼随消息消失自动正确；
 * 唯一不自动的是重 roll/重新生成（宿主 clearMessageData 白名单不碰
 * ttToolkit、普通 regenerate 不调）——生成开始须由本仓主动清档（见
 * generator 的生成周期起点）。
 *
 * 写入约束：extra 会经宿主 structuredClone 进 swipe 槽——写进去的必须
 * 是纯数据（{title,content} 数组＋字符串），不得含函数/响应式代理。
 */
import { EXTRA_NAMESPACE_KEY, getChatMessages, saveCurrentChat, type ChatMessage } from '@/host';
import type { ParsedOption, ParseReport } from './parse';

/** 命名空间内的选项键（为同位置存别的楼层派生数据留位——summary 已用 summaryHidden）。 */
const EXTRA_CHOICE_KEY = 'choice';

/** 存档白名单与 ParseReport['path'] 同源（漏登记＝该路径存档被当坏档丢弃）。 */
const PARSE_PATHS: readonly ParseReport['path'][] = ['json', 'partial', 'bracket_fallback', 'json_reject', 'empty'];

/** 楼层存档的读取形态（write 侧写入同构）。 */
export interface StoredFloorOptions {
    options: ParsedOption[];
    parsePath: ParseReport['path'];
    /**
     * partial 路径的残缺丢弃数；其余路径缺席。刻意 optional：v1.5.17
     * 存量档无此字段，守门若要求在场＝升级后旧楼选项全被判坏档清空。
     */
    dropped?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 楼层取用：越界/非对象返回 null（读侧坏档与写侧越界统一的守门入口）。 */
function messageAt(index: number): Record<string, unknown> | null {
    const messages = getChatMessages();
    const message = index >= 0 && index < messages.length ? messages[index] : undefined;
    return isRecord(message) ? message : null;
}

function choiceNamespaceOf(message: Record<string, unknown>): Record<string, unknown> | null {
    if (!isRecord(message.extra)) return null;
    const ns = message.extra[EXTRA_NAMESPACE_KEY];
    return isRecord(ns) ? ns : null;
}

/** 存档形状守门：options 为 {title,content} 字符串数组、parsePath 属合法枚举、dropped 缺席合法／在场须为数字。 */
function isStoredFloorOptions(value: unknown): value is StoredFloorOptions {
    if (!isRecord(value) || !Array.isArray(value.options) || typeof value.parsePath !== 'string') return false;
    if (!PARSE_PATHS.includes(value.parsePath as ParseReport['path'])) return false;
    if (value.dropped !== undefined && typeof value.dropped !== 'number') return false;
    return value.options.every(o => isRecord(o) && typeof o.title === 'string' && typeof o.content === 'string');
}

/**
 * 读某楼层的选项存档；无档/越界/形状不符（坏档）一律 null——坏档回退
 * 空态优于抛错打断装载（派生数据不值得 Fail Fast 打断聊天）。
 */
export function readFloorOptions(index: number): StoredFloorOptions | null {
    const message = messageAt(index);
    if (!message) return null;
    const stored = choiceNamespaceOf(message)?.[EXTRA_CHOICE_KEY];
    if (!isStoredFloorOptions(stored)) return null;
    // 逐条重建：与消息单例解耦，调用方改返回值不污染 extra
    return {
        options: stored.options.map(o => ({ title: o.title, content: o.content })),
        parsePath: stored.parsePath,
        dropped: stored.dropped,
    };
}

/**
 * 写某楼层的选项存档并立即落盘。
 * 写前对象校验（expectMessage 非 null 时）：删楼会使索引左移，索引处可能
 * 已换成别的消息——不一致即丢弃不写（防把选项落到错误楼层并落盘）。
 * 越界/消息缺席/对象已换返回 false（不抛），由调用方决定展示口径。
 *
 * expectMessage 必填、以 null 显式表示「无凭据故不校验」：可选参数会让
 * 新调用方漏传时静默失去防漂移保护，而这种保护失效本身不报错（改必填
 * 后漏传由类型门拦下）。
 */
export function writeFloorOptions(args: { index: number; payload: StoredFloorOptions; expectMessage: ChatMessage | null }): boolean {
    const { index, payload, expectMessage } = args;
    const message = messageAt(index);
    if (!message) return false;
    if (expectMessage !== null && message !== expectMessage) return false;
    // 命名空间容器缺则补建（同引用回写无副作用）
    const extra: Record<string, unknown> = isRecord(message.extra) ? message.extra : {};
    message.extra = extra;
    const namespace: Record<string, unknown> = isRecord(extra[EXTRA_NAMESPACE_KEY]) ? extra[EXTRA_NAMESPACE_KEY] : {};
    extra[EXTRA_NAMESPACE_KEY] = namespace;
    // 纯数据重建（见文件头 structuredClone 约束）；dropped 仅在有值时
    // 写入——undefined 属性在守门 typeof 判定下会误判坏档
    const stored: StoredFloorOptions = { options: payload.options.map(o => ({ title: o.title, content: o.content })), parsePath: payload.parsePath };
    if (payload.dropped !== undefined) stored.dropped = payload.dropped;
    namespace[EXTRA_CHOICE_KEY] = stored;
    saveCurrentChat();
    return true;
}

/**
 * 清某楼层的选项存档并落盘（生成开始时调——宿主不替我们清，见文件头）。
 * expectMessage 校验同 write 侧（必填、null＝无凭据不校验）；无档/越界即
 * 无事发生（不触发无谓落盘）。
 */
export function clearFloorOptions(index: number, expectMessage: ChatMessage | null): void {
    const message = messageAt(index);
    if (!message) return;
    if (expectMessage !== null && message !== expectMessage) return;
    const namespace = choiceNamespaceOf(message);
    if (!namespace || !(EXTRA_CHOICE_KEY in namespace)) return;
    delete namespace[EXTRA_CHOICE_KEY];
    saveCurrentChat();
}

/** 当前末条 assistant 楼层索引（倒序首条非 user/非 system）；无则 null。 */
export function latestAssistantFloorIndex(): number | null {
    const messages = getChatMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!isRecord(message)) continue;
        if (message.is_user !== true && message.is_system !== true) return i;
    }
    return null;
}
