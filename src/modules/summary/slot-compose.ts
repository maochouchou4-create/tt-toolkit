/**
 * 前情摘要注入槽的文本组合（纯函数：node 冒烟直测字面）。
 *
 * 槽 value 模板为拍板定稿文本（一字不差）：三段节选规则＝有大总结无
 * 小总结省略【小总结·近期】节、无大总结有小总结省略【大总结】节、
 * 两者皆空返回空串（空串＝调用方清槽不注册）。
 */

/** 单条小总结的槽呈现所需字段（SmallSummaryRecord 的文本子集——组合只关心显示）。 */
export interface SlotSmallEntry {
    text: string;
    fromFloor: number;
    toFloor: number;
}

export interface SlotComposeInput {
    /** 当前大总结正文（空串＝尚无） */
    bigSummary: string;
    /** 未折叠小总结（时间序） */
    smalls: SlotSmallEntry[];
}

const SLOT_HEADER = '以下是本对话更早剧情的压缩摘要（对应楼层已折叠，不再单独发送）。摘要内容均为已经发生的事实，与后续对话历史具有同等效力，不得与之矛盾，也不要重复摘要中已记录的情节。';

/** 单条小总结块（i＝1 基批次序；楼层号给用户看的是 1 基）。 */
function smallBlock(entry: SlotSmallEntry, index: number): string {
    return `【小总结·第${index}批｜约第${entry.fromFloor + 1}-${entry.toFloor + 1}楼】\n${entry.text}`;
}

/**
 * 组合槽 value（纯函数）。多条小总结以空行分隔（单条形态与定稿模板
 * 逐字一致）；大总结段与小总结段之间按模板的空行衔接。
 */
export function composeSlotValue(input: SlotComposeInput): string {
    const big = input.bigSummary.trim();
    const smalls = input.smalls.filter(e => e.text.trim() !== '');
    if (big === '' && smalls.length === 0) return '';
    const sections: string[] = [];
    if (big !== '') sections.push(`【大总结】\n${big}`);
    if (smalls.length > 0) {
        sections.push(`【小总结·近期】\n${smalls.map((e, i) => smallBlock(e, i + 1)).join('\n\n')}`);
    }
    return `${SLOT_HEADER}\n\n<前情摘要>\n${sections.join('\n\n')}\n</前情摘要>`;
}
