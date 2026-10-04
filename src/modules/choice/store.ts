/**
 * choice 会话内存态（选项条本身：生成→展示→点击）。
 *
 * 不持久化（方案 §2.2：消息级持久化/swipe 翻页归批C）——切聊天/刷新
 * 即清空，属预期行为。唯一跨会话的是最近一次组装 dump（排障/验收用，
 * 也不持久化）。
 */
import { defineStore } from 'pinia';
import type { ParseReport } from './parse';

export type GeneratePhase = 'idle' | 'running' | 'error';

export const useChoiceStore = defineStore('tt-choice', {
    state: () => ({
        phase: 'idle' as GeneratePhase,
        /** 当前展示的选项（空＝无结果） */
        options: [] as Array<{ title: string; content: string }>,
        /** 生成失败信息（phase=error 时展示） */
        error: '',
        /** 最近一次解析路径（json / bracket_fallback / empty——排障展示） */
        lastParsePath: '' as ParseReport['path'] | '',
        /** 最近一次组装 dump 文本（编辑器/调试 tab 可视；全局口同源） */
        lastDump: '',
    }),
    actions: {
        beginGenerate() {
            this.phase = 'running';
            this.error = '';
        },
        succeed(options: Array<{ title: string; content: string }>, parsePath: ParseReport['path'], dump: string) {
            this.phase = 'idle';
            this.options = options;
            this.lastParsePath = parsePath;
            this.lastDump = dump;
        },
        fail(message: string) {
            this.phase = 'error';
            this.error = message;
        },
        clearOptions() {
            this.options = [];
            this.lastParsePath = '';
        },
    },
});
