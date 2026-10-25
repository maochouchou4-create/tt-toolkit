/**
 * 全局排障口装配：__TT_TOOLKIT__.storage 与 __TT_TOOLKIT__.prompts。
 *
 * 独立成件的原因：两口是浏览器验收与 node 冒烟的双流共用面，原内联在
 * 入口；批 A 发布件分块后 node 冒烟面拆独立 chunk，两口必须能让入口与
 * 冒烟块各自静态导入——留原位会迫使冒烟块反向依赖入口。本件只被两侧
 * 引导消费，自身不进任何分支判断。
 */
import { toolkitGlobalPort } from '@/global-port';
import { dumpStorage } from '@/storage/debug';
import { assembleCurrent, parseOptions, DEBUG_MALFORMED_RAW } from '@/modules/choice';
import { dumpPersonaTask } from '@/modules/persona';
import { TASK_KEYS, type TaskKey } from '@/prompts';
import { version } from '@/version';

/** 存储域 dump 挂入统一排障口（devtools 直取 __TT_TOOLKIT__.storage.dump()）。 */
export function installStoragePort(): void {
    toolkitGlobalPort().storage = Object.freeze({ dump: dumpStorage });
}

/**
 * 提示词排障口 __TT_TOOLKIT__.prompts（dump / assemble / parseOptions）：
 * 用户浏览器验收与排障共用（与生成管线同一条组装路径）。
 *
 * 分派登记在本件：dump 的任务键全集跨模块——choice 走组装管线，persona
 * 两任务由 persona 模块实现，两者是兄弟模块，谁都不该引对方；本件是唯一
 * 同时持有两侧的地方。任务键全集即 dump 支持全集，键外取值给「未知任务键」报错。
 */
export function installPromptsPort(): void {
    const port = {
        version,
        /**
         * 全量组装 dump（宿主真实数据；async——世界书扫描是异步的）。
         * task＝'choice'（默认）走选项生成组装；persona 任务走
         * dumpPersonaTask（运行时任务态以空呈现，模板与注入全文可见）。
         */
        async dump(task?: string | { task?: string }): Promise<string> {
            const raw = typeof task === 'string' ? task : task?.task;
            const key = TASK_KEYS.includes(raw as TaskKey) ? (raw as TaskKey) : raw === undefined ? 'choice' : undefined;
            if (!key) {
                throw new Error(`未知任务键 ${String(raw)}——可选值：${TASK_KEYS.join(' / ')}`);
            }
            const dumpText = key === 'choice'
                ? (await assembleCurrent()).dumpText
                : await dumpPersonaTask(key);
            console.info(dumpText);
            return dumpText;
        },
        /** 组装结果原始形态（消息数组＋trace；choice 任务专用口） */
        assemble: assembleCurrent,
        /** 解析纯函数（畸形输出回退路径的确定性探针） */
        parseOptions,
        /** 调试用固定畸形样本（配合 parseOptions 验证回退） */
        DEBUG_MALFORMED_RAW,
    };
    Object.freeze(port);
    toolkitGlobalPort().prompts = port;
}
