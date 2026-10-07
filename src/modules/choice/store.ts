/**
 * choice 会话内存态（选项条本身：生成→展示→点击）＋楼层归属标识。
 *
 * 选项语义＝「当前楼层的选项」：持久化真身在消息 extra.ttToolkit.choice
 * （persist.ts，随宿主聊天文件落盘），本 store 只是展示态——切楼层/
 * 切聊天按楼层重新装载（restore/syncToFloor），无存档即空态。
 * 唯一跨会话的是最近一次组装 dump（排障/验收用，不持久化）。
 */
import { defineStore } from 'pinia';
import { getChatMessages } from '@/host';
import type { ParseReport } from './parse';
import { clearFloorOptions, readFloorOptions, writeFloorOptions } from './persist';

export type GeneratePhase = 'idle' | 'running' | 'error';

/**
 * 生成锚定的楼层消息对象引用（写前校验防删楼后索引漂移）。
 * 刻意不进 pinia state：reactive 会把对象包成 proxy，身份比较（===）
 * 对回原始目标永远失配——守卫需要的是裸引用，模块级持有。
 */
let anchoredFloorMessage: unknown = null;

export const useChoiceStore = defineStore('tt-choice', {
    state: () => ({
        phase: 'idle' as GeneratePhase,
        /** 当前展示的选项（空＝无结果） */
        options: [] as Array<{ title: string; content: string }>,
        /** 生成失败信息（phase=error 时展示） */
        error: '',
        /** 最近一次解析路径（json / bracket_fallback / empty——排障展示） */
        lastParsePath: '' as ParseReport['path'] | '',
        /** 最近一次组装 dump 文本（全局口 __TT_TOOLKIT__.prompts.dump 同源文本） */
        lastDump: '',
        /** 选项归属楼层（展示标识；读档索引永远实时取末楼——无双真相源） */
        floorIndex: null as number | null,
    }),
    actions: {
        beginGenerate() {
            this.phase = 'running';
            this.error = '';
        },
        succeed(options: Array<{ title: string; content: string }>, parsePath: ParseReport['path'], dump: string, floorIndex: number | null, floorMessage: unknown) {
            this.phase = 'idle';
            this.options = options;
            this.lastParsePath = parsePath;
            this.lastDump = dump;
            this.floorIndex = floorIndex;
            anchoredFloorMessage = floorMessage;
            // 消息级落盘（写前对象校验防删楼漂移）；无锚楼（聊天尚无
            // assistant 楼层）＝无处可挂，仅展示
            if (floorIndex !== null) {
                writeFloorOptions(floorIndex, options, parsePath, floorMessage);
            }
        },
        fail(message: string) {
            this.phase = 'error';
            this.error = message;
            // 错误态下残留上一轮徽标是误导（错误显示正确性）：fail 即清路径徽标
            this.lastParsePath = '';
        },
        /**
         * 按楼层装载存档（切楼层/切聊天/事件重载的统一入口）；
         * 无存档即空态。锚定引用取装载瞬间的消息对象。
         */
        restore(index: number) {
            const saved = readFloorOptions(index);
            this.options = saved?.options ?? [];
            this.lastParsePath = saved?.parsePath ?? '';
            this.floorIndex = index;
            anchoredFloorMessage = getChatMessages()[index] ?? null;
        },
        /** 末楼不存在（空聊天等）：清展示态、无归属。 */
        syncToFloor(index: number | null) {
            if (index === null) {
                this.options = [];
                this.lastParsePath = '';
                this.floorIndex = null;
                anchoredFloorMessage = null;
                return;
            }
            this.restore(index);
        },
        clearOptions() {
            this.options = [];
            this.lastParsePath = '';
            // 清当前楼层存档（带对象校验防误清别楼——锚定引用与 floorIndex
            // 是同一次生成/装载锚定的配对）；清后归属作废
            if (this.floorIndex !== null) {
                clearFloorOptions(this.floorIndex, anchoredFloorMessage);
                this.floorIndex = null;
                anchoredFloorMessage = null;
            }
        },
    },
});
