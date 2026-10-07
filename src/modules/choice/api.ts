/**
 * choice 模块全局域（extension_settings.ttToolkit.choice）。
 *
 * 端点身份（url/key/model）住在统一端点表（modules/apis），选中的端点
 * 收归全局活动键（v1.4.0 起，见 apis/storage readActiveEndpointId）。
 * 任务参数（输出契约/思考强度/流式/温度）已固化为代码常量
 * （apis/task-defaults TASK_DEFAULTS，用户面零旋钮），本域只承载
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
 * choice 域键（extension_settings.ttToolkit 下；migration 侧引用此常量，
 * 字面量单一事实源）。
 */
export const GLOBAL_CHOICE_KEY = 'choice';

/** 生成行为参数（全局域；含池抽取参数）。 */
export interface ChoiceGenParams extends PoolGenParams {
    /** 每次生成选项条数（语义＝pinned+drawn 的目标基数） */
    count: number;
    /** 上下文历史轮数（一轮＝一问一答） */
    contextRounds: number;
    /** 选项正文字数下/上限 */
    minChars: number;
    maxChars: number;
    /** 点击行为：fill 填入 / append 追加 / send 直接发送 */
    clickBehavior: 'fill' | 'append' | 'send';
    /** 调试：跳过 API、用固定畸形样本走解析路径（验收「回退可确定性触发」） */
    debugForceRaw: boolean;
}

export interface ChoiceDomain {
    gen: ChoiceGenParams;
    /** 条目池数据（两层结构，见 pool/types.ts）。 */
    pool: PoolDomainData;
}

export const DEFAULT_GEN_PARAMS: ChoiceGenParams = {
    count: 4,
    contextRounds: 6,
    minChars: 10,
    maxChars: 60,
    clickBehavior: 'fill',
    debugForceRaw: false,
    ...DEFAULT_POOL_GEN_PARAMS,
};

function readDomain(): ChoiceDomain {
    const raw = getGlobal<Partial<ChoiceDomain>>(GLOBAL_CHOICE_KEY);
    return {
        // 池参数缺省合并＋值域钳制（raw 里的历史值不可信：oversample 越界/
        // overflow 拼错都钳回合法域，旧存档无字段不崩）；旧档 task 键随
        // 未知字段纪律丢弃（任务参数固化拍板）
        gen: normalizePoolGenParams({ ...DEFAULT_GEN_PARAMS, ...(raw?.gen ?? {}) }),
        pool: normalizePoolData(raw?.pool),
    };
}

function writeDomain(mutate: (domain: ChoiceDomain) => void): void {
    const domain = readDomain();
    mutate(domain);
    // 写侧同样过值域钳制（双复核 P3）：导入/备份等 mutate 路径写入的 gen
    // 不经 readDomain 的合并防线——落盘前统一归一化，坏值（oversample
    // 越界/overflow 拼错）不会经写通道持久化
    domain.gen = normalizePoolGenParams(domain.gen);
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
