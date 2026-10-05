/**
 * 统一 API 端点域类型（整合轮II）。
 *
 * 端点表是全模块共享的单一真相源：choice（选项生成）与 persona（人设
 * 生成/润色）不再各配各的 API，端点身份（地址/密钥/模型）全部取自本表；
 * 任务参数（输出契约/思考强度/流式等）留在各自任务域。
 */
import type { OutputContract, ReasoningEffort } from './client';

/** 端点条目：身份五元组（id 稳定，供两任务域引用）。 */
export interface ApiEndpoint {
    id: string;
    name: string;
    /** API base 地址（用户原样填写；发送前由客户端归一） */
    url: string;
    /** 直连密钥（走宿主 reverse_proxy 通道直达上游，不进宿主 secret store） */
    key: string;
    model: string;
}

/** choice 任务的生成参数（端点身份之外的全部请求面）。 */
export interface ChoiceTaskParams {
    outputContract: OutputContract;
    reasoningEffort: ReasoningEffort;
    stream: boolean;
    temperature: number;
    maxTokens: number;
}

/** 端点表存储域（extension_settings.ttToolkit.apis＝端点数组本体）。 */
export type ApiDomain = ApiEndpoint[];

/** 一次性迁移报告（结构沿 persona 域先例——smoke 断言消费）。 */
export interface ApiMigrationReport {
    /** 幂等跳过（端点表已在场） */
    skipped: boolean;
    /** 收编来源（'choice' | 'persona'） */
    collectedFrom: string[];
    /** persona 侧 id 撞车后的重分配映射（旧 id → 新 id） */
    idRemaps: Array<{ from: string; to: string }>;
    /** 与已有条目按 url+model 合并的条数（choice 侧优先保留） */
    mergedDuplicates: number;
    /** 收编后端点总数 */
    endpointCount: number;
}
