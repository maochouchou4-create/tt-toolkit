/**
 * choice 模块任务参数（全局域 extension_settings.ttToolkit.choice）。
 *
 * 端点身份（url/key/model）住在统一端点表（modules/apis），
 * 本域只保存 choice 任务自身的生成参数与选中端点引用。
 *
 * response_format 支持度实测结论（三家端点）：
 *   - json_schema：ds 官方端点不支持（400），GG（流式）与 CC 支持；
 *   - json_object：三家全部支持；
 *   - GG（gcli 假流式端点）非流式请求挂死——stream=true 是硬需求。
 * 据此默认：任务参数 outputContract 默认 json_object（三家通吃的稳妥
 * 档），GG 类端点用户按 UI 提示改 json_schema＋开流式。
 */
import { getGlobal, setGlobal } from '@/storage';
import type { OutputContract, ReasoningEffort } from '@/modules/apis/client';
import { normalizeReasoningEffort } from '@/modules/apis/client';
import type { ApiEndpoint } from '@/modules/apis/types';
import { readApiDomain } from '@/modules/apis/storage';
import type { PoolGenParams } from './pool/types';
import { DEFAULT_POOL_GEN_PARAMS, normalizePoolData, normalizePoolGenParams, type PoolDomainData } from './pool/normalize';

/**
 * choice 域键（extension_settings.ttToolkit 下；migration 侧引用此常量，
 * 字面量单一事实源）。
 */
export const GLOBAL_CHOICE_KEY = 'choice';

/** choice 任务参数（挂在统一端点上的生成档位；端点身份不在其列）。 */
export interface ChoiceTaskParams {
    /** 输出契约档位（见文件头实测结论） */
    outputContract: OutputContract;
    /** 思考强度（off＝不发送字段；转发语义见 apis/client.ts buildGenerateBody 注释） */
    reasoningEffort: ReasoningEffort;
    /** 流式（GG 假流式端点硬需求；流式同时是长请求的防挂死姿势） */
    stream: boolean;
    temperature: number;
    maxTokens: number;
}

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
    /** choice 任务参数（输出契约/思考强度/流式/温度/max_tokens） */
    task: ChoiceTaskParams;
    /**
     * 选中端点（引用统一端点表条目 id；空＝未配置）。字段名即存储键，
     * 与 persona 侧的 endpointId 不同名是存量数据契约——改名即丢用户
     * 端点选择，两侧命名差异保留。
     */
    activeEndpointId: string;
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

/** 任务参数缺省值（三家端点实测后的稳妥档）。 */
export const DEFAULT_TASK_PARAMS: ChoiceTaskParams = {
    outputContract: 'json_object',
    reasoningEffort: 'off',
    stream: true,
    temperature: 0.7,
    maxTokens: 2048,
};

function normalizeTaskParams(raw: unknown): ChoiceTaskParams {
    // 存档里的历史值不可信：档位枚举/数值范围逐字段守门
    const r = (raw ?? {}) as Partial<Record<keyof ChoiceTaskParams, unknown>>;
    const contract = r.outputContract === 'json_schema' || r.outputContract === 'prompt_only' ? r.outputContract : 'json_object';
    return {
        outputContract: contract,
        reasoningEffort: normalizeReasoningEffort(r.reasoningEffort),
        stream: typeof r.stream === 'boolean' ? r.stream : true,
        temperature: typeof r.temperature === 'number' && Number.isFinite(r.temperature) ? r.temperature : 0.7,
        maxTokens: typeof r.maxTokens === 'number' && Number.isInteger(r.maxTokens) && r.maxTokens > 0 ? r.maxTokens : 2048,
    };
}

function readDomain(): ChoiceDomain {
    const raw = getGlobal<Partial<ChoiceDomain>>(GLOBAL_CHOICE_KEY);
    return {
        task: normalizeTaskParams(raw?.task),
        activeEndpointId: typeof raw?.activeEndpointId === 'string' ? raw.activeEndpointId : '',
        // 池参数同样缺省合并＋值域钳制（raw 里的历史值不可信：oversample 越界/
        // overflow 拼错都钳回合法域，旧存档无字段不崩）
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
    domain.task = normalizeTaskParams(domain.task);
    setGlobal(GLOBAL_CHOICE_KEY, domain);
}

/** 读当前生效端点（activeEndpointId 命中统一端点表；缺席返回 null＝未配置）。 */
export function resolveChoiceEndpoint(): ApiEndpoint | null {
    const d = readDomain();
    return readApiDomain().find(e => e.id === d.activeEndpointId) ?? null;
}

export const choiceStorage = {
    readDomain,
    /** 读-改-写单通道（池层/导入层共用；写前必经 readDomain 规范化） */
    writeDomain,
    /** 更新 choice 任务参数（部分字段补丁） */
    updateTask(patch: Partial<ChoiceTaskParams>): void {
        writeDomain(d => {
            d.task = normalizeTaskParams({ ...d.task, ...patch });
        });
    },
    /** 选中统一端点表中的某条端点 */
    setActiveEndpoint(id: string): void {
        writeDomain(d => {
            d.activeEndpointId = id;
        });
    },
    updateGenParams(patch: Partial<ChoiceGenParams>): void {
        writeDomain(d => {
            d.gen = { ...d.gen, ...patch };
        });
    },
};
