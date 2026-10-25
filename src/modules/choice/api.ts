/**
 * choice 模块全局域（extension_settings.ttToolkit.choice）。
 *
 * 端点身份（url/key）住在统一服务商表（modules/apis），模型选择权在
 * 任务档案（apis/task-profiles，API 页任务模型卡按任务行配置）。
 * 流式/输出契约按任务固化（apis/task-defaults TASK_PARAMS），本域只承载
 * 生成参数（gen）与条目池数据（pool）。
 *
 * response_format 支持度实测结论（三家端点，json_object 恒定的依据存档）：
 *   - json_schema：ds 官方端点不支持（400），GG（流式）与 CC 支持；
 *   - json_object：三家全部支持；
 *   - GG（gcli 假流式端点）非流式请求挂死——stream=true 是硬需求。
 */
import { getGlobal, setGlobal } from '@/storage';
import type { PoolGenParams } from './pool/types';
import { DEFAULT_POOL_GEN_PARAMS, normalizePoolData, normalizePoolGenParams, type PoolDomainData } from './pool/normalize';

/**
 * choice 域键（extension_settings.ttToolkit 下；字面量单一事实源）。
 */
export const GLOBAL_CHOICE_KEY = 'choice';

/** 生成行为参数（全局域；含池抽取参数）。 */
export interface ChoiceGenParams extends PoolGenParams {
    /** 每次生成选项条数（语义＝pinned+drawn 的目标基数） */
    count: number;
    /** 选项正文字数下/上限 */
    minChars: number;
    maxChars: number;
    /** 点击行为：fill 填入 / append 追加 / send 直接发送 */
    clickBehavior: 'fill' | 'append' | 'send';
    /**
     * 跳过 API、用固定畸形样本走完整生成管线（验收「回退可确定性触发」）。
     *
     * 它不是调试残留而是冒烟的**唯一无网全管线通道**：node 冒烟无宿主网络，
     * 生成链的组装→发送→解析→落盘四段只有这一条能在不发请求的前提下被
     * 逐段观测。恒 false，冒烟驱动它时必须在 finally 侧还原（否则后续断言
     * 全部在假管线上跑）。
     */
    debugForceRaw: boolean;
}

export interface ChoiceDomain {
    gen: ChoiceGenParams;
    /** 条目池数据（两层结构，见 pool/types.ts）。 */
    pool: PoolDomainData;
}

/** 全局域键登记：键常量与域类型同处归属模块（登记面说明见 storage/service.ts）。 */
declare module '@/storage/service' {
    interface GlobalDomain {
        /** choice 域（生成参数＋条目池；本文件 GLOBAL_CHOICE_KEY） */
        choice?: ChoiceDomain;
    }
}

export const DEFAULT_GEN_PARAMS: ChoiceGenParams = {
    count: 4,
    minChars: 30,
    maxChars: 120,
    clickBehavior: 'fill',
    debugForceRaw: false,
    ...DEFAULT_POOL_GEN_PARAMS,
};

/**
 * gen 域逐字段重建（未知键丢弃）：字段清单即 ChoiceGenParams 的单一
 * 事实源——退役旋钮（如 contextRounds）在旧档里的残留随任一写通道
 * 自然清除。池参数部分的值域钳制由 normalizePoolGenParams 承担
 * （泛型透传多余字段）。
 */
function normalizeGenParams(raw: Partial<ChoiceGenParams>): ChoiceGenParams {
    const merged = normalizePoolGenParams({ ...DEFAULT_GEN_PARAMS, ...raw });
    return {
        ...merged,
        count: merged.count,
        minChars: merged.minChars,
        maxChars: merged.maxChars,
        clickBehavior: merged.clickBehavior,
        debugForceRaw: merged.debugForceRaw,
    };
}

function readDomain(): ChoiceDomain {
    // 读回的是存档原值：类型是 ChoiceDomain，字段可缺可坏——缺省合并与逐
    // 字段重建在下面做（normalize 面吃不可信形状，收紧只在 API 面）。
    const raw: Partial<ChoiceDomain> | undefined = getGlobal(GLOBAL_CHOICE_KEY);
    return {
        // 缺省合并＋逐字段重建＋池参数值域钳制（raw 里的历史值不可信：
        // oversample 越界/overflow 拼错都钳回合法域，旧存档无字段不崩）；
        // 旧档 task 键等未知字段随字段清单纪律丢弃（任务参数固化拍板）
        gen: normalizeGenParams(raw?.gen ?? {}),
        pool: normalizePoolData(raw?.pool),
    };
}

function writeDomain(mutate: (domain: ChoiceDomain) => void): void {
    const domain = readDomain();
    mutate(domain);
    // 写侧同样过字段重建（双复核 P3）：导入/备份等 mutate 路径写入的 gen
    // 不经 readDomain 的合并防线——落盘前统一归一化，坏值（oversample
    // 越界/overflow 拼错）与未知键不会经写通道持久化
    domain.gen = normalizeGenParams(domain.gen);
    setGlobal(GLOBAL_CHOICE_KEY, domain);
}

export const choiceStorage = {
    readDomain,
    /** 读-改-写单通道（池层/导入层共用；写前必经 readDomain 规范化） */
    writeDomain,
    updateGenParams(patch: Partial<ChoiceGenParams>): void {
        writeDomain(d => {
            d.gen = { ...d.gen, ...patch };
        });
    },
};
