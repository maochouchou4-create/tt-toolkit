/**
 * choice 会话内存态：生成相位、失败信息与生成锚（楼层索引＋消息身份）。
 *
 * 选项的展示真相源＝楼层存档（消息 extra.ttToolkit.choice，persist.ts）——
 * 本 store 不存展示副本：每条楼的块由 floor-view 各自读档渲染，切楼层/
 * 切聊天/删楼/swipe 的对账全在展示层按存档现场做。
 * 锚只服务状态行/错误行的归属：生成起点锚楼（不随末楼漂移、不跨聊天
 * 残留），渲染前按楼层索引＋消息身份双重校验。
 * 唯一跨会话的是最近一次组装 dump（排障/验收用，不持久化）。
 */
import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import type { ChatMessage } from '@/host';
import { writeFloorOptions, type StoredFloorOptions } from './persist';

export type GeneratePhase = 'idle' | 'running' | 'error';

export const useChoiceStore = defineStore('tt-choice', {
    state: () => ({
        phase: 'idle' as GeneratePhase,
        /** 生成失败信息（phase=error 时画在锚楼） */
        error: '',
        /** 最近一次组装 dump 文本（全局口 __TT_TOOLKIT__.prompts.dump 同源文本） */
        lastDump: '',
        /** 生成起点锚楼索引（状态行/错误行归属；null＝尚未生成/无锚） */
        anchorFloorIndex: null as number | null,
        /**
         * 生成起点锚楼的消息对象（身份校验防删楼/换聊天后索引漂移）。
         * markRaw：reactive 会把对象包成 proxy，与 getChatMessages() 的裸
         * 引用恒不相等——守卫要的可比较裸引用，故不参与响应式代理。
         */
        anchorMessage: null as ChatMessage | null,
    }),
    actions: {
        /** 生成周期起点入态（生成锚由 beginGenerationCycle 捕锚后传入）。 */
        beginGenerate(anchor: { floorIndex: number | null; floorMessage: ChatMessage | null }) {
            this.phase = 'running';
            this.error = '';
            this.anchorFloorIndex = anchor.floorIndex;
            this.anchorMessage = anchor.floorMessage === null ? null : markRaw(anchor.floorMessage);
        },
        /**
         * 生成成功入态并落档。存档两件套（options/dropped）复用
         * StoredFloorOptions（与落盘形态同一真相源，禁同形双类型）。
         * 返回是否真的落到该楼层：无锚楼或写前对象校验失败＝false，由
         * generator 转为可见失败（写档失败不再静默）。
         */
        succeed(payload: StoredFloorOptions & { dump: string; floorIndex: number | null; floorMessage: ChatMessage | null }): boolean {
            this.phase = 'idle';
            this.lastDump = payload.dump;
            // 无锚楼（聊天尚无 assistant 楼层）＝无处可挂；floorIndex 与
            // floorMessage 同一次锚定成对出现：引用缺席＝无校验凭据，宁不写
            if (payload.floorIndex === null || payload.floorMessage === null) return false;
            return writeFloorOptions({
                index: payload.floorIndex,
                payload,
                expectMessage: payload.floorMessage,
            });
        },
        fail(message: string) {
            this.phase = 'error';
            this.error = message;
        },
    },
});
