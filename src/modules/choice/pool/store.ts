/**
 * 条目池 store（Pinia）：PoolTab 的只读桥。
 * 真相源＝default-pool.json 资产（经 pool/asset.ts 同步落地），本 store 只
 * 透传读取＋gen 运行时开关这一个用户写面（写穿 choice 域、revision 失效）。
 */

import { defineStore } from 'pinia';
import { choiceStorage } from '../api';
import { readPoolData } from './storage';
import type { PoolEntry, PoolGenParams } from './types';

export const usePoolStore = defineStore('tt-pool', {
    state: () => ({
        /** 写穿计数：读透传 getter 的失效信号 */
        revision: 0,
    }),
    getters: {
        masterPool(): PoolEntry[] {
            void this.revision;
            return readPoolData().masterPool;
        },
        /** 池抽取参数（choice 域 gen 的池参数部分）。 */
        poolGen(): PoolGenParams {
            void this.revision;
            return choiceStorage.readDomain().gen;
        },
    },
    actions: {
        updatePoolGen(patch: Partial<PoolGenParams>) {
            choiceStorage.updateGenParams(patch);
            this.revision++;
        },
    },
});
