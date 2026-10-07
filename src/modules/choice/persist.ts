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
import { getChatMessages, saveCurrentChat } from '@/host';
import type { ParsedOption, ParseReport } from './parse';

/** extra 下的本扩展命名空间键（与全局/聊天域键同名，位置不同域）。 */
const EXTRA_NAMESPACE_KEY = 'ttToolkit';
/** 命名空间内的选项键（为同位置将来存别的楼层派生数据留位）。 */
const EXTRA_CHOICE_KEY = 'choice';

const PARSE_PATHS: readonly ParseReport['path'][] = ['json', 'bracket_fallback', 'json_reject', 'empty'];

/** 楼层存档的读取形态（write 侧写入同构）。 */
export interface StoredFloorOptions {
    options: ParsedOption[];
    parsePath: ParseReport['path'];
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

/** 存档形状守门：options 为 {title,content} 字符串数组、parsePath 属合法枚举。 */
function isStoredFloorOptions(value: unknown): value is StoredFloorOptions {
    if (!isRecord(value) || !Array.isArray(value.options) || typeof value.parsePath !== 'string') return false;
    if (!PARSE_PATHS.includes(value.parsePath as ParseReport['path'])) return false;
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
    };
}

/**
 * 写某楼层的选项存档并立即落盘。
 * 写前对象校验（expectMessage 在场时）：删楼会使索引左移，索引处可能
 * 已换成别的消息——不一致即丢弃不写（防把选项落到错误楼层并落盘）。
 * 越界/消息缺席/对象已换返回 false（不抛），由调用方决定展示口径。
 */
export function writeFloorOptions(index: number, options: ParsedOption[], parsePath: ParseReport['path'], expectMessage?: unknown): boolean {
    const message = messageAt(index);
    if (!message) return false;
    if (expectMessage !== undefined && message !== expectMessage) return false;
    // 命名空间容器缺则补建（同引用回写无副作用）
    const extra: Record<string, unknown> = isRecord(message.extra) ? message.extra : {};
    message.extra = extra;
    const namespace: Record<string, unknown> = isRecord(extra[EXTRA_NAMESPACE_KEY]) ? extra[EXTRA_NAMESPACE_KEY] : {};
    extra[EXTRA_NAMESPACE_KEY] = namespace;
    // 纯数据重建（见文件头 structuredClone 约束）
    namespace[EXTRA_CHOICE_KEY] = { options: options.map(o => ({ title: o.title, content: o.content })), parsePath };
    saveCurrentChat();
    return true;
}

/**
 * 清某楼层的选项存档并落盘（生成开始时调——宿主不替我们清，见文件头）。
 * expectMessage 校验同 write 侧；无档/越界即无事发生（不触发无谓落盘）。
 */
export function clearFloorOptions(index: number, expectMessage?: unknown): void {
    const message = messageAt(index);
    if (!message) return;
    if (expectMessage !== undefined && message !== expectMessage) return;
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
