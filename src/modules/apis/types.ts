/**
 * 统一 API 服务商域类型。
 *
 * 服务商表是全模块共享的接入身份单一真相源：url+key＝服务商，
 * 模型选择权在任务档案（src/tasks.ts 粒度，各任务行独立选服务商
 * 与模型）——两层分离，不做「任务级 override 缝补」。
 */

/** 服务商条目：url+key 的接入身份（id 稳定，供任务档案引用）。 */
export interface ApiProvider {
    id: string;
    name: string;
    /** API base 地址（用户原样填写；发送前由客户端归一） */
    url: string;
    /** 直连密钥（走宿主 reverse_proxy 通道直达上游，不进宿主 secret store） */
    key: string;
    /** 拉取的模型清单缓存（跨会话持久；空数组＝从未拉取）。任务模型行的下拉源。 */
    models: string[];
    /**
     * 端点不支持续写（prefill）的能力记忆：该端点曾因带 prefill 收 400、
     * 去 prefill 重试成功后落下的事实标记（baseUrl 粒度，跨会话持久）。
     * 生成链据此跳过 prefill；不自动翻回（防探测抖动），复位走 API 页手动按钮。
     */
    noPrefill: boolean;
}

/** 服务商表存储域（extension_settings.ttToolkit.apis＝服务商数组本体）。 */
export type ApiDomain = ApiProvider[];
