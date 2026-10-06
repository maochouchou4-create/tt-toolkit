/**
 * 自动生成：MESSAGE_RECEIVED 监听守卫链。
 *
 * 守卫顺序（越早越便宜）：quiet 静默生成跳过 → 消息文本空跳过 →
 * messageId===0 跳过 → autoGenerate 关跳过 → 生成中跳过 → 未选端点
 * console.warn 跳过。全部通过后 fire-and-forget 触发生成。
 *
 * 监听器内不得 await（重活脱钩）：宿主 eventSource.emit 串行 await 每个
 * 监听器，emit 后紧接 finalizeMessageContent→CHARACTER_MESSAGE_RENDERED
 * ——监听器 await 整次生成会把正文渲染推迟到生成完成（卡酒馆助手类脚本，
 * 核实记录见 host/events.ts 头注释）。generateOptions 在首个 await 前同步
 * 置位 activeAbort（并发互斥），守卫与脱钩之间无竞态窗口。
 *
 * API 未配时 console.warn 而不弹任何 UI：AI 刚回复完抢焦点体验极差。
 */

import { eventBus, event_types, getChatMessages } from '@/host';
import { choiceStorage, resolveChoiceEndpoint } from './api';
import { generateOptions, isGenerating } from './generator';

/** 幂等安装标记（浏览器/node 两路 init 都可能调用）。 */
let installed = false;

/** 安装自动生成监听（幂等）。 */
export function installAutoGenerate(): void {
    if (installed) return;
    installed = true;
    eventBus.on(event_types.MESSAGE_RECEIVED, (...args: unknown[]) => {
        // 返回值透传：宿主 emit 侧忽略它，冒烟经 stub emit 断言同步返回语义
        return handleMessageReceived(args[0], args[1]);
    });
}

/**
 * 守卫链本体（导出仅供冒烟直调断言各分支——浏览器路径经 eventBus 进来）。
 * 同步返回：通过全部守卫时 generateOptions 已启动（其首个 await 前同步
 * 置位并发锁），但本函数不等待它完成。
 */
export function handleMessageReceived(messageId: unknown, type: unknown): boolean {
    // quiet＝宿主静默/内部生成（核实记录：script.js:3914 Generate('quiet')，
    // 经 4748 正常 emit）——自动出选项只对真正的 AI 回复生效
    if (type === 'quiet') return false;

    // 消息本体：messageId 是楼层绝对索引（核实记录见 host/events.ts 头注释）。
    // 分组消息 emit 形态是 (chat_id, type)——非数字一律不当楼层索引
    // （chat_id 恰为纯数字串时 Number() 兜底会误判成楼层，双复核 P3 修复）
    if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId < 0) return false;
    const idx = messageId;
    const messages = getChatMessages();
    const message = idx < messages.length ? messages[idx] : undefined;
    const mes = message?.mes;
    if (typeof mes !== 'string' || mes.trim() === '') return false;
    // messageId===0：首楼欢迎消息（角色卡开场白），不是 AI 对玩家的回复
    if (idx === 0) return false;

    if (!choiceStorage.readDomain().gen.autoGenerate) return false;

    if (isGenerating()) return false;

    const endpoint = resolveChoiceEndpoint();
    if (!endpoint) {
        // 不弹 UI（理由见文件头）；留 console 线索供排障
        console.warn('[tt-toolkit][choice] 自动生成跳过：未选择生成端点');
        return false;
    }

    // fire-and-forget：立即返回，生成在后台跑（脱钩理由见文件头）
    void generateOptions();
    return true;
}
