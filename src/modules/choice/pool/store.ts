/**
 * 条目池 store（Pinia）：PoolTab 只读浏览桥。
 * 真相源＝default-pool.json 资产（经 pool/asset.ts 同步落地），内容随插件
 * 发布更新（页面重载生效）；生成行为参数（含池抽取开关）归 choice
 * settings store 的 gen 面（写穿 choice 域），本 store 无写面。
 */

import { defineStore } from 'pinia';
import { readPoolData } from './storage';
import type { PoolEntry } from './types';

export const usePoolStore = defineStore('tt-pool', {
    getters: {
        masterPool(): PoolEntry[] {
            return readPoolData().masterPool;
        },
    },
});
