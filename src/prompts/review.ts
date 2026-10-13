/**
 * 复核回合的指令模块（引擎侧 text 模块）。
 *
 * 为什么是模块而不是调用侧 splice 的一串字符串：复核指令走的是引擎组装
 * （trace＋dump 一条龙），调用侧 splice 出去的轮次在 trace 与组装 dump 里都
 * 是隐形的——实发序列与观测面分家，排障时 dump 里只看到两段，线上跑的是三段。
 *
 * 为什么它不进提示词域（不可编辑）：指令正文与它的返回格式是一份契约（解析只按
 * 行首「块.叶 → 」切开）。让用户在设置面改它，改坏了不会报错，只会让每一份档案
 * 的复核结论静默降级——与「用户改错一份提示词就静默降级」的既有面相比，这一处
 * 没有可接受的下游：契约坏了连降级提示都读不出来。同理，`PERSONA_REVIEW_MODULE`
 * 与指令正文都**不导出**：把 TextModule 外露等于开第二条组装路径（谁都能绕过
 * `assemblePersonaReviewMessages` 自己拼一条），而这条路径没人需要复核。
 *
 * 位置契约：这条 user 消息**并进传给 `requestOnce` 的 messages**，且本轮不带
 * 起手词——它是本轮最后一条消息。绝不拼进 promptArray：将来若有人给复核轮加回
 * 起手词，400 去-prefill 重发会把 promptArray 重置成无起手词的一份
 * （`promptArrayNoPrefill = messages`），拼在里面的指令会静默消失，而那一轮
 * 返回的是「档案段正文」而不是复核结论。
 */
import { assembleMessages, type AssemblyResult, type PersonaAssemblySources } from './engine';
import type { TextModule } from './types';

/**
 * 复核指令的任务头（首行标记）。
 *
 * 它同时是「这一条消息是复核轮」的机判依据：冒烟的 SSE 桩按末条 user 消息
 * 的首行分派回复内容（curator／personaGen／review 三段各据自己的头——三段的
 * 头都从 prompts 侧导出，桩只 import，改了模板不必回来改桩）。
 */
export const PERSONA_REVIEW_TASK_HEAD = '[任务：查重并改写]';

/** 档案占位符（只在本模块的填充里认，见 assemblePersonaReviewMessages）。 */
const PROFILE_PLACEHOLDER = '{{profile}}';

/**
 * 复核指令正文（契约全文；`{{profile}}` 由 assemblePersonaReviewMessages 填
 * 档案段产出的完整文本，含块行、叶行与已填的值）。
 *
 * 格式样例三行带三个前导空格：那是成文里为可读性缩进的内容，本文件照抄不改——
 * 指令文本与解析契约是同一份，抄的时候顺手「修正」缩进，模型看到的样例与解析器
 * 实际接受的行首就差了一截。
 */
const PERSONA_REVIEW_INSTRUCTION = `${PERSONA_REVIEW_TASK_HEAD} 下面这份人设档案里，有的事实被写重了。请逐块核对，然后：
1. 只在「两个叶在说同一件事」时才判重复。若两个叶写的是同一母题的不同维度（别人怎么看他／他内心缺什么／什么在推他行动），那是三个都要写的维度，不算重复。
2. 判定重复时点名到「块.叶」，并指明保留哪一叶。
3. 给出被判定叶的完整改写值——要保留原叶名、换成一件真正不同的事实，不许留空、不许写「同上」「略」。
4. 若全篇没有重复，只回「无重复」四字，不要附任何说明。
5. 回答格式（必须严格照此，一条一行，不附任何说明文字）：
   块.叶A → 改写后的完整值
   块.叶B → 改写后的完整值
   ……一条重复对输出两行：第一行是保留的叶与它保留原样的理由（写成「块.叶A → 保留」），第二行是被改写的叶与它的新值（写成「块.叶B → 新值」）。分号、空格、换行都不特殊，写清整句即可，解析只按行首的「块.叶 → 」切开。

<profile>
{{profile}}
</profile>`;

/** 复核指令的引擎模块（单模块：指令是一份契约，不拆成可分别停用的几段）。 */
const PERSONA_REVIEW_MODULE: TextModule = {
    kind: 'text',
    id: 'persona_review_instruction',
    name: '查重复核指令',
    role: 'user',
    order: 10,
    enabled: true,
    content: PERSONA_REVIEW_INSTRUCTION,
};

/**
 * 组装复核轮的指令消息（走引擎管线：trace/dump 与档案段同一口径）。
 *
 * `profile` 是档案段产出的完整文本；其余字段与档案段共用同一份 sources（复用同一
 * 份策展产出，复核轮不重跑策展——重跑会让 schema 变，指令里点名的「块.叶」随之
 * 可能不存在）。
 *
 * {{profile}} 在**组装之后**填，不进通用占位符链，两个原因都在那儿：档案正文是
 * 任意文本（先填档案再填别的键会让档案里的 `{{user}}` 字面量被换成真名），而通用
 * 链上的键对另外两轮是空的（用户在策展/档案轮自己写的 `{{profile}}` 字面量会被
 * 抹掉）。档案为空时原样保留占位符：没有档案可填，模型看见一个没填的宏位比看见
 * 一段空档案更容易发现「这一轮没有输入」。
 */
export function assemblePersonaReviewMessages(sources: PersonaAssemblySources, profile: string): AssemblyResult {
    const result = assembleMessages([PERSONA_REVIEW_MODULE], sources);
    if (!profile) return result;
    return {
        ...result,
        messages: result.messages.map(message => ({
            ...message,
            content: message.content.replaceAll(PROFILE_PLACEHOLDER, profile),
        })),
    };
}