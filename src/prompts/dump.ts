/**
 * 消息组装 dump（方案 §2.3——批B 验收断言的依赖设施）。
 *
 * 渲染 AssemblyResult（messages＋trace）为可读文本：各模块注入与否
 * 逐项可见＋消息数组逐条全文。消费面：全局口 __TT_TOOLKIT__.prompts.dump()
 * （浏览器控制台）、node 冒烟机判。
 */
import type { AssemblyResult } from './engine';

/** 模块注入标记：已注入 ✓ / 跳过 ✗（原因）。 */
function traceLine(t: AssemblyResult['trace'][number], index: number): string {
    const flag = t.injected ? '✓' : '✗';
    const source = t.source ? ` [${t.source}]` : '';
    const note = t.note ? ` —— ${t.note}` : '';
    return `${String(index + 1).padStart(2, ' ')}. ${flag} ${t.moduleName}${source}${note}`;
}

/** dump 文本形态：trace 段（模块注入清单）＋ messages 段（逐条全文）。 */
export function renderDump(result: AssemblyResult, at = new Date().toISOString()): string {
    const lines: string[] = [];
    lines.push(`=== 消息组装 dump @ ${at} ===`);
    lines.push(`模块注入清单（${result.trace.length} 个模块，${result.trace.filter(t => t.injected).length} 个已注入）：`);
    result.trace.forEach((t, i) => lines.push(traceLine(t, i)));
    lines.push('');
    lines.push(`消息数组（${result.messages.length} 条）：`);
    result.messages.forEach((m, i) => {
        lines.push(`--- [${i}] ${m.role} ---`);
        lines.push(m.content);
    });
    return lines.join('\n');
}

/** trace 的紧凑单行形态（冒烟机判断言用：逐模块「id:注入/跳过」）。 */
export function renderTraceCompact(result: AssemblyResult): string {
    return result.trace.map(t => `${t.moduleId}:${t.injected ? 'in' : 'skip'}`).join(' ');
}
