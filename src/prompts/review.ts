/**
 * 审稿回合的指令模块（引擎侧 text 模块）。
 *
 * 为什么是模块而不是调用侧 splice 的一串字符串：审稿指令走的是引擎组装
 * （trace＋dump 一条龙），调用侧 splice 出去的轮次在 trace 与组装 dump 里都
 * 是隐形的——实发序列与观测面分家，排障时 dump 里只看到两段，线上跑的是三段。
 *
 * 为什么它不进提示词域（不可编辑）：指令正文与它的返回格式是一份契约（解析
 * 按「扫回执档案＋逐叶对账」落地）。让用户在设置面改它，改坏了不会报错，只会让每一份档案
 * 的审稿结论静默降级——与「用户改错一份提示词就静默降级」的既有面相比，这一处
 * 没有可接受的下游：契约坏了连降级提示都读不出来。同理，`PERSONA_REVIEW_MODULE`
 * 与指令正文都**不导出**：把 TextModule 外露等于开第二条组装路径（谁都能绕过
 * `assemblePersonaReviewMessages` 自己拼一条），而这条路径没人需要审稿。
 *
 * 位置契约：这条 user 消息**并进传给 `requestOnce` 的 messages**，且本轮不带
 * 起手词——它是本轮最后一条消息。绝不拼进 promptArray：将来若有人给审稿轮加回
 * 起手词，400 去-prefill 重发会把 promptArray 重置成无起手词的一份
 * （`promptArrayNoPrefill = messages`），拼在里面的指令会静默消失，而那一轮
 * 返回的是「档案段正文」而不是审稿结论。
 */
import { assembleMessages, type AssemblyResult, type PersonaAssemblySources } from './engine';
import type { TextModule } from './types';

/**
 * 审稿指令的任务头（首行标记）。
 *
 * 它同时是「这一条消息是审稿轮」的机判依据：冒烟的 SSE 桩按末条 user 消息
 * 的首行分派回复内容（curator／personaGen／review 三段各据自己的头——三段的
 * 头都从 prompts 侧导出，桩只 import，改了模板不必回来改桩）。
 */
export const PERSONA_REVIEW_TASK_HEAD = '[任务：审稿并修订]';

/** 档案占位符（只在本模块的填充里认，见 assemblePersonaReviewMessages）。 */
const PROFILE_PLACEHOLDER = '{{profile}}';

/**
 * 审稿指令正文（契约全文；`{{profile}}` 由 assemblePersonaReviewMessages 填
 * 档案段产出的完整文本，含块行、叶行与已填的值）。
 *
 * 返回契约是两态、机判分明：无可挑剔只回「无需修改」四字（省输出，且保住
 * 「没毛病」与「有毛病改好了」的区分）；有修订回整份档案（yaml 围栏）。模型
 * 不被要求输出分析过程或点名行——解析端拿到的是一份档案而不是结论清单，
 * 脚本的裁定全在逐叶比对那侧（review.ts 的合并守卫），指令侧只把「结构不得动」
 * 钉死。
 *
 * 审稿五查只查写法病（平庸／含糊／自相矛盾／可推导废话／不像真人），重复文本
 * 由机检（redundancy.ts 的 literal 同值判定）兜底——短卡里重复多是写法病的
 * 并发症状，治写法病即治本。
 */
const PERSONA_REVIEW_INSTRUCTION = `${PERSONA_REVIEW_TASK_HEAD} 下面这份人设档案是一张锚点卡——它只钉住「推不出来、每轮用得上」的锚，不写传记。你是它的审稿员。逐叶过一遍五查，查出就改：
1. 平庸病：值是换皮复读（同义堆叠）或没有行为方向的裸评语（如「温柔善良」）——改成带行为方向的标签或一句短语，让模型能照着演。
2. 含糊病：「有时」「可能」「某种程度上」替代了具体事实——改成具体事实。
3. 自相矛盾：同一叶或相邻叶里的两条信息不能同时成立——改到能同时成立，或删掉弱的那条的信息量（不得留空、不得写「同上」「略」）。
4. 可推导废话：某叶的内容能从另一叶或卡外素材直接推出（如从核心矛盾推出的情绪反应套路）——本叶换成指向式（点名目标，如「软肋见恐惧软肋」）或换一件推不出来的新事实；指向式彼此不得同文，各自点名不同侧面，写不出不同侧面就换新事实（同文指向＝新增完全同值组＝整轮降级）。
5. 不像真人：通篇全是优点或全是设定、没有一处缺点／怪癖／执念——在信号最强的叶补一条（就一条，补在哪由素材定），不新开叶。
除此之外一律不改：风格统一、键名译名、与五查无关的措辞，都不在审稿范围——改了它们只会让档案和生成段的观测记录对不上账。
只要发现任何要改的叶，就动笔修订；修订遵守：
- 换上的内容必须出自本对话素材或与之自洽，不得新增素材外的事实；
- 不许留空、不许写「同上」「略」、不许写「未知」「待定」「N/A」类占位。
最后输出：若有任何修订，输出修订后的完整档案——整份用 \`\`\`yaml 围栏包住；顶层块与叶的清单、名称、顺序、层级与输入逐字一致，不增不删不改名；没有修订到的叶一律逐字保留原文，含标点与顺序。
若全篇没有任何要改的地方，只回「无需修改」四字——不要输出档案，不要附任何说明。

<profile>
{{profile}}
</profile>`;

/** 审稿指令的引擎模块（单模块：指令是一份契约，不拆成可分别停用的几段）。 */
const PERSONA_REVIEW_MODULE: TextModule = {
    kind: 'text',
    id: 'persona_review_instruction',
    name: '审稿修订指令',
    role: 'user',
    order: 10,
    enabled: true,
    content: PERSONA_REVIEW_INSTRUCTION,
};

/**
 * 组装审稿轮的指令消息（走引擎管线：trace/dump 与档案段同一口径）。
 *
 * `profile` 是档案段产出的完整文本；其余字段与档案段共用同一份 sources（复用同一
 * 份策展产出，审稿轮不重跑策展——重跑会让 schema 变，档案与回执的骨架就对不上，
 * 整轮审稿会被骨架校验作废）。
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
