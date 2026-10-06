/**
 * 剧情走向域（choice 模块自持）：答「剧情往哪走」的用户设置——
 * 自由文本＋已应用预设正文（chat 域）＋用户自建预设列表（全局域）。
 * 消费方＝choice 生成管线（组装时取走向文本）与「选项生成」设置页
 * 走向卡；prompts 引擎只按 AssemblySources.storyDirection 收文，不回读。
 *
 * 存储键名与域位置均沿用走向域诞生时的形态（键不动＝零迁移，老用户的
 * 走向文本/预设不丢）：
 *   - 聊天域 chat_metadata.ttToolkit.storyDirection（已应用预设正文＋
 *     自由文本）——写走 writeChatMetadata 立即保存通道；
 *   - 全局域 extension_settings.ttToolkit.directionPresets（预设列表）。
 */

import { defineStore } from 'pinia';
import { getChat, getGlobal, newId, setChat, setGlobal } from '@/storage';
import type { StoryDirection } from '@/prompts';

const GLOBAL_DIRECTION_PRESETS_KEY = 'directionPresets';
const CHAT_STORY_DIRECTION_KEY = 'storyDirection';

/** 用户自建剧情走向预设（全局域；自定义预设取代固定六标签）。 */
export interface DirectionPreset {
    id: string;
    /** 预设正文（应用后注入 <direction> 段的走向指令本体） */
    text: string;
}

export const useStoryDirectionStore = defineStore('tt-story-direction', {
    state: () => ({
        /** 写穿计数：读透传 getter 的失效信号 */
        revision: 0,
    }),
    getters: {
        storyDirection(): StoryDirection {
            void this.revision;
            const d = getChat<Partial<StoryDirection>>(CHAT_STORY_DIRECTION_KEY);
            // 旧档案是 {tag, freeText} 形态（六选一标签时代）：tag 已废弃
            // （用户拍板固定标签不保留）——读档只取 freeText，tag 丢弃；
            // presetText 旧档案没有，缺省空串
            return {
                presetText: typeof d?.presetText === 'string' ? d.presetText : '',
                freeText: typeof d?.freeText === 'string' ? d.freeText : '',
            };
        },
        directionPresets(): DirectionPreset[] {
            void this.revision;
            const raw = getGlobal<unknown>(GLOBAL_DIRECTION_PRESETS_KEY);
            if (!Array.isArray(raw)) return [];
            // 逐项守门：外部写坏的条目（缺 id/text 或类型不对）剔除而非抛错
            // ——预设列表是用户可重建的辅助数据，不值得 Fail Fast 打断组装
            return raw.filter(
                (p): p is DirectionPreset =>
                    typeof p === 'object' && p !== null && typeof (p as DirectionPreset).id === 'string' && typeof (p as DirectionPreset).text === 'string',
            );
        },
    },
    actions: {
        setStoryDirection(patch: Partial<StoryDirection>) {
            const current = this.storyDirection;
            setChat(CHAT_STORY_DIRECTION_KEY, { ...current, ...patch });
            this.revision++;
        },
        /** 把当前自由文本存为预设（预设列表全局保存，所有聊天可用）。 */
        addDirectionPreset(text: string): void {
            const value = text.trim();
            if (!value) return;
            const preset: DirectionPreset = { id: newId('dir'), text: value };
            setGlobal(GLOBAL_DIRECTION_PRESETS_KEY, [...this.directionPresets, preset]);
            this.revision++;
        },
        deleteDirectionPreset(id: string): void {
            // 只删全局列表；已应用聊天存的是正文快照，不受影响（快照
            // 自包含，删除预设不清空已应用的走向）
            setGlobal(GLOBAL_DIRECTION_PRESETS_KEY, this.directionPresets.filter(p => p.id !== id));
            this.revision++;
        },
    },
});
