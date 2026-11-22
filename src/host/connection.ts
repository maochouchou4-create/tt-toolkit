/**
 * 宿主当前连接读取面（「跟随酒馆会话连接」的数据源）。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，本文件施工时 HEAD）：
 * - getContext() 转发面（scripts/st-context.js）：mainApi＝main_api（:208）、
 *   chatCompletionSettings＝oai_settings（:235）、getChatCompletionModel
 *   （:298 ← scripts/openai.js:2746，按 chat_completion_source 分派各
 *   *_model 字段的单一出口，纯函数不依赖 this）。
 * - 主聊天自己的出站身份组装（scripts/openai.js sendOpenAIRequest）：
 *   reverse_proxy+proxy_password 只在「反代非空且源在 proxySupportedSources
 *   （:4287：claude/openai/mistralai/makersuite/vertexai/deepseek/xai/zai/
 *   moonshot）」时发（:4401-4405）；custom_url 只对 custom 源发（:4474）。
 * - 身份解析在宿主后端（tt-application chat_completion_service/config.rs
 *   resolve_api_config）：custom 源 custom_url 非空→密钥取宿主 secret store
 *   CUSTOM 键；非 custom 源无反代→官方 URL＋按源取宿主密钥——**密钥全程
 *   不经过本扩展**，跟随只镜像源/模型/自定义地址/反代四件。
 *
 * 本层只做「窄接口收敛」：宿主宽松对象收窄成 HostConnection，判挡逻辑
 * （哪些源可跟）不在此层——守卫与档位清单住在消费侧 task-profiles
 * （枚举住守卫旁的理由同 REASONING_EFFORTS）。
 */

import { getTavernContext } from './context';

/** 宿主当前连接快照（readHostConnection 现读现返，不缓存）。 */
export interface HostConnection {
    /** main_api 现值（'openai'＝聊天补全系；其余＝跟随不可用） */
    mainApi: string;
    /** oai_settings.chat_completion_source 现值 */
    source: string;
    /** 当前源选定的模型名（getChatCompletionModel()；''＝未选模型） */
    model: string;
    /** custom 源的自定义端点地址（oai_settings.custom_url） */
    customUrl: string;
    /** custom 源的报文格式（oai_settings.custom_api_format；''＝缺省 openai_compat） */
    customApiFormat: string;
    /** opencode 源的报文格式（oai_settings.opencode_api_format；''＝缺省 openai_compat） */
    opencodeApiFormat: string;
    /** 反代地址（oai_settings.reverse_proxy；是否随行由消费侧按源清单判） */
    reverseProxy: string;
    /** 反代通道密钥（oai_settings.proxy_password，普通设置字段非 secret） */
    proxyPassword: string;
}

function readStringField(settings: Record<string, unknown> | undefined, key: string): string {
    const value = settings?.[key];
    return typeof value === 'string' ? value : '';
}

/**
 * 现读宿主当前连接（每次调用取现值——跟随语义＝生成时实时镜像，
 * 酒馆侧切连接/切模型立即生效，无缓存无同步）。
 * 宿主上下文缺席（getContext() null）返回 null＝跟随不可用。
 */
export function readHostConnection(): HostConnection | null {
    const ctx = getTavernContext();
    if (!ctx) return null;
    let model = '';
    if (typeof ctx.getChatCompletionModel === 'function') {
        // 接收者纪律：经 context 对象转发的纯函数调用，函数体不依赖 this
        const raw = ctx.getChatCompletionModel();
        model = typeof raw === 'string' ? raw : '';
    }
    const settings = ctx.chatCompletionSettings;
    return {
        mainApi: typeof ctx.mainApi === 'string' ? ctx.mainApi : '',
        source: readStringField(settings, 'chat_completion_source'),
        model,
        customUrl: readStringField(settings, 'custom_url'),
        customApiFormat: readStringField(settings, 'custom_api_format'),
        opencodeApiFormat: readStringField(settings, 'opencode_api_format'),
        reverseProxy: readStringField(settings, 'reverse_proxy'),
        proxyPassword: readStringField(settings, 'proxy_password'),
    };
}
