/**
 * SSE 流式读取：完整帧状态机拼接 delta（帧形态见 client.ts 文件头核实记录）。
 *
 * 表达距离声明：AFPL 合规——fork 按「逐行 split＋pop 保留半行」的
 * 行缓冲骨架实现，本实现改为按事件边界（\n\n）切帧的状态机：缓冲区
 * 只在完整帧落地时消费，帧内 data 字段逐条解析；流收尾时把无终止符
 * 的尾帧也消费掉（fork 骨架会静默丢弃残留在缓冲里的尾行）。
 * 宿主契约语义不变：`data: {json}\n\n` / `data: [DONE]\n\n`，delta 在
 * choices[0].delta.content。
 *
 * 帧级错误判别有两个结构化标志：①宿主在流中途失败时补的错误帧**伪装成
 * 正常 chunk**（HTTP 仍是 200，正文位置照旧），只有信封 id 前缀是标志
 * ——不认它，错误正文就会被当成模型产出返回给上层（实测后果：整段错误
 * 文本被当成策展 schema 送进人设第二段）。②流已开后上游自身报错被宿主
 * 原样转发的 `{"error":{…}}` 帧（真实事故：上游 400 拒收 assistant 结尾，
 * 该帧被当普通帧吞掉、失败在 runlog 里长得像 ok 空响应）。畸形帧仍静默
 * 跳过（重帧/心跳）；部分上游的正常帧带 `error: null` 键，null 不算错误帧。
 */

import { HostApiError, isHostErrorEnvelopeId } from '@/host';
import { readUpstreamError } from './client-error';

const SSE_FRAME_TERMINATOR = '\n\n';

/** 单帧解析结果：正文增量 + 截断信号 + 错误帧（isErrorFrame 为真即错误帧，宿主信封与上游 error 对象两源）。 */
interface SseFrameOutcome {
    delta: string;
    finishReason: string | null;
    isErrorFrame: boolean;
    errorText: string;
}

function parseSseFrame(frame: string): SseFrameOutcome {
    const outcome: SseFrameOutcome = { delta: '', finishReason: null, isErrorFrame: false, errorText: '' };
    for (const field of frame.split('\n')) {
        if (!field.startsWith('data:')) continue;
        const data = field.slice('data:'.length).trim();
        if (data === '[DONE]') continue;
        let json: {
            id?: unknown;
            error?: unknown;
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
        };
        try {
            json = JSON.parse(data) as typeof json;
        } catch {
            // 单帧畸形不推翻整次读取（重帧/心跳帧等）
            continue;
        }
        const delta = json?.choices?.[0]?.delta?.content ?? '';
        const reason = json?.choices?.[0]?.finish_reason;
        if (typeof reason === 'string' && reason) outcome.finishReason = reason;
        // 错误帧判定只认结构化标志（宿主信封 id 前缀 / 上游 error 键），正文
        // 文本只作报告载体。两种来源归一成同一出口：取到非 null 文案即错误帧。
        // 正常产出即使正文以错误标签开头也照常收下——判据不看文本就不会误杀
        // （文本判别只留给拿不到信封的落盘楼层场景）。
        const frameError = isHostErrorEnvelopeId(json?.id) ? delta : readUpstreamError(json);
        if (frameError !== null) {
            outcome.isErrorFrame = true;
            outcome.errorText += frameError;
        } else {
            outcome.delta += delta;
        }
    }
    return outcome;
}

export async function readStream(response: Response): Promise<{ content: string; finishReason: string | null }> {
    if (!response.body) throw new Error('流式响应无 body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let pending = '';
    // 截断取证：末帧 finish_reason=length＝内容被服务端 token 上限掐断
    // （推理模型思维链与正文共享上限）——不捕它，截断会伪装成解析失败
    let finishReason: string | null = null;

    const consumeFrame = (frame: string): void => {
        const outcome = parseSseFrame(frame);
        if (outcome.isErrorFrame) throw new HostApiError(outcome.errorText || '生成端点在流内返回错误帧');
        full += outcome.delta;
        if (outcome.finishReason !== null) finishReason = outcome.finishReason;
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // \r\n 归一成 \n：上游个别代理会改写换行风格，帧边界探测只认 \n\n
            pending += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
            let cut = pending.indexOf(SSE_FRAME_TERMINATOR);
            while (cut !== -1) {
                consumeFrame(pending.slice(0, cut));
                pending = pending.slice(cut + SSE_FRAME_TERMINATOR.length);
                cut = pending.indexOf(SSE_FRAME_TERMINATOR);
            }
        }
        // 尾帧可能没有终止符就断流：一并消费（丢它会少最后一段 delta）
        consumeFrame(pending);
    } catch (err) {
        // 兜底关闭被放弃的流（宿主错误帧抛出的路径）：不关则宿主侧连接与
        // 解码器要等 GC 才回收，而这里已经确定不会再读一帧。cancel 失败
        // 不覆盖原始错误（cancel 的语义是「不再需要」，失败无补救动作）。
        await reader.cancel().catch(() => undefined);
        throw err;
    }
    return { content: full, finishReason };
}
