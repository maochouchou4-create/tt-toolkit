/**
 * choice 模块 API 配置（全局域 extension_settings.ttToolkit.choice）。
 *
 * response_format 支持度实测结论（批B 开工实测，三家端点）：
 *   - json_schema：ds 官方端点不支持（400），GG（流式）与 CC 支持；
 *   - json_object：三家全部支持；
 *   - GG（gcli 假流式端点）非流式请求挂死——stream=true 是硬需求。
 * 据此默认：新建配置 outputContract 默认 json_object（三家通吃的稳妥
 * 档），GG 类端点用户按 UI 提示改 json_schema＋开流式。
 */
import { getGlobal, setGlobal } from '@/storage';
import type { OutputContract } from '@/host';

const GLOBAL_CHOICE_KEY = 'choice';

export interface ApiConfig {
    id: string;
    name: string;
    /** API base（用户填什么形态都行——normalizeApiUrl 统一规范化） */
    apiurl: string;
    /** 直连密钥（经 proxy_password 通道直达上游，不进宿主 secret store） */
    key: string;
    model: string;
    /** 输出契约档位（见文件头实测结论） */
    outputContract: OutputContract;
    /** 流式（GG 假流式端点硬需求；流式同时是长请求的防挂死姿势） */
    stream: boolean;
    temperature: number;
    maxTokens: number;
}

/** 生成行为参数（全局域；auto_generate 归批C）。 */
export interface ChoiceGenParams {
    /** 每次生成选项条数 */
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
    apis: ApiConfig[];
    activeApiId: string;
    gen: ChoiceGenParams;
}

export const DEFAULT_GEN_PARAMS: ChoiceGenParams = {
    count: 4,
    contextRounds: 6,
    minChars: 10,
    maxChars: 60,
    clickBehavior: 'fill',
    debugForceRaw: false,
};

function readDomain(): ChoiceDomain {
    const raw = getGlobal<Partial<ChoiceDomain>>(GLOBAL_CHOICE_KEY);
    return {
        apis: Array.isArray(raw?.apis) ? (raw.apis as ApiConfig[]) : [],
        activeApiId: typeof raw?.activeApiId === 'string' ? raw.activeApiId : '',
        gen: { ...DEFAULT_GEN_PARAMS, ...(raw?.gen ?? {}) },
    };
}

function writeDomain(mutate: (domain: ChoiceDomain) => void): void {
    const domain = readDomain();
    mutate(domain);
    setGlobal(GLOBAL_CHOICE_KEY, domain);
}

/** 读当前生效 API 配置（activeApiId 命中；缺席返回 null＝未配置）。 */
export function resolveActiveApi(): ApiConfig | null {
    const d = readDomain();
    return d.apis.find(a => a.id === d.activeApiId) ?? null;
}

export function createApiConfig(name: string): ApiConfig {
    return {
        id: `api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        apiurl: '',
        key: '',
        model: '',
        outputContract: 'json_object',
        stream: true,
        temperature: 0.7,
        maxTokens: 2048,
    };
}

export const choiceStorage = {
    readDomain,
    /** 增改单条 API 配置（按 id 整体替换；新增即追加） */
    upsertApi(api: ApiConfig): void {
        writeDomain(d => {
            const idx = d.apis.findIndex(a => a.id === api.id);
            if (idx >= 0) d.apis[idx] = api;
            else d.apis.push(api);
        });
    },
    deleteApi(id: string): void {
        writeDomain(d => {
            d.apis = d.apis.filter(a => a.id !== id);
            if (d.activeApiId === id) d.activeApiId = d.apis[0]?.id ?? '';
        });
    },
    setActiveApi(id: string): void {
        writeDomain(d => {
            d.activeApiId = id;
        });
    },
    updateGenParams(patch: Partial<ChoiceGenParams>): void {
        writeDomain(d => {
            d.gen = { ...d.gen, ...patch };
        });
    },
};
