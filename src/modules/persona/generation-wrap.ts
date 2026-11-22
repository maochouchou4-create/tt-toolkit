/**
 * persona 侧的围栏与输入包装面：起手词围栏词汇、输出围栏剥离、参考块与
 * 用户输入的包裹。
 *
 * 为什么独立成面：生成链（generation.ts）与调用面（generation-request.ts）
 * 都只消费这些纯文本原语，谁都不该为「围栏长什么样」负责——围栏形态是
 * 一处定义、多处派生（起手词、剥离判据、prefill 补回），拆开后这份词汇的
 * 归属落在这里，两条链单向引用，不成环。
 */

import { isStrictKeyLine } from './yaml';

/**
 * 起手词围栏（全模块唯一定义）：策展段起手词、档案段首键起手词、以及剥
 * 围栏时的「模型有没有把起手词带回来」判据都从它派生。三处各写一份字面
 * 量时，围栏形态一改就会静默漏判补回——补回首行判错不报错，只把坏结构
 * 送进下一段。
 */
export const PREFILL_FENCE = '```yaml';

/** 策展段起手词：只要围栏头（schema 的全部块键由模型自己续写）。 */
export const PREFILL_SCHEMA = PREFILL_FENCE + '\n';

/** 参考块包装（XiTa 式文件引用围栏；空内容返回空串不入 messages）。 */
export function wrapAsXiTaReference(content: string, title: string): string {
    if (!content || !content.trim()) return '';
    return `\n> [FILE: ${title}]\n"""\n${content}\n"""`;
}

/**
 * 剥掉模型输出外层的 ``` 围栏。prefill 被续写但模型未闭合围栏时，按首行
 * 形态补回结构头再剥。
 */
export function stripYamlFence(rawText: string, prefillContent?: string): string {
    const yamlRegex = /```(?:yaml)?\n([\s\S]*?)```/i;
    const match = rawText.match(yamlRegex);
    if (match && match[1]) return match[1].trim();

    let text = rawText;
    // ⚠️ 这五处判据（起手词在场／首行已含起手词／首行不是围栏／trim 后
    // 不是围栏／三段首行白名单）必须同批看：漏判任一处的后果是静默的
    // ——把已经带头的正文再拼一次，拼出「```yaml基本信息: 姓名: …」这种
    // 坏结构，全程不报错。
    if (prefillContent && !text.startsWith(prefillContent) && !text.startsWith(PREFILL_FENCE)) {
        const trimRes = text.trim();
        if (!trimRes.startsWith(PREFILL_FENCE) && resumesPrefillHead(trimRes, prefillContent)) {
            text = prefillContent + text;
        }
    }
    return text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
}

/**
 * 首行是否像「起手词之后该接上的那一行」。两条判据都是结构性的，不认死
 * 任何词：
 *   1. 块键段取自起手词本身——档案段起手词按 schema 首块拼，正文从块键
 *      起首＝模型把块头自己写了回来，直接接上即可；
 *   2. 首行是严格键行（键: 值形态，yaml.ts 单源判据）＝续写落在了首块的
 *      叶上（真实形态：目录现值的首叶，如「年龄: …」）。叶名不枚举——
 *      schema 首叶随目录改版变，枚举叶名在每次改首叶后就漏判一次；漏判
 *      的后果是首块头静默丢失、首块叶逃出审稿轮的叶级守卫（曾只认
 *      「姓名」即此事故：目录首叶早已是「年龄」，冒烟夹具恰好也用
 *      「姓名」当首叶，把它洗绿了）。
 * 误黏边界（接受）：散文首行恰为「词: 」形态（如「例如: 」）会被当键行
 * 补头——概率与代价（多一个可解析的块头）都低于漏判（静默丢块头）。
 */
function resumesPrefillHead(trimmed: string, prefillContent: string): boolean {
    const prefillBlockKey = prefillContent.startsWith(PREFILL_FENCE)
        ? prefillContent.slice(PREFILL_FENCE.length + 1).replace(/:$/, '')
        : '';
    // 块键切不出东西＝起手词只有围栏头（策展段就是这种起手词：schema 的
    // 全部块键由模型自己续写，起手词里本来就没有块键可比）。这种起手词
    // 之后模型必然是从围栏头接着写下去的，所以这一支恒真是有意的：把
    // 空串交给 startsWith 会让块键判据整段空转，写成显式分支是让「恒真」
    // 与「这里根本没有块键可比」在代码里分得开，改的人一眼看得见。
    if (!prefillBlockKey) return true;
    if (trimmed.startsWith(prefillBlockKey)) return true;
    const newlineIdx = trimmed.indexOf('\n');
    return isStrictKeyLine(newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx));
}

/**
 * 用户输入的安全化包装：双引号换单引号 + SYSTEM_OP 指令块
 * （LOGIC_CONSTRAINT——生成结果对用户请求的刚性约束）。
 */
export function wrapInputForSafety(request: string): string {
    if (!request) return '';
    const safeRequest = request.replace(/"/g, "'");
    return `
[SYSTEM_OP: LOGIC_CONSTRAINT]
[USER_QUERY]: "${safeRequest}"
[EXECUTION]:
The generated profile MUST strictly adhere to the User Query above.
Treat this as a rigid logical constraint for the simulation database.
`;
}
