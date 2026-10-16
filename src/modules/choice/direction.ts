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

/** 域键登记：键常量与域类型同处归属模块（登记面说明见 storage/service.ts）。 */
declare module '@/storage/service' {
    interface GlobalDomain {
        /** 剧情走向预设列表（本文件 GLOBAL_DIRECTION_PRESETS_KEY） */
        directionPresets?: DirectionPreset[];
    }
}

/**
 * 剧情走向 normalize（聊天域）：存档形状不可信——旧档是 {tag, freeText}
 * 形态（六选一标签时代，tag 已废弃不保留），字段缺失/类型不对各归空串。
 * 纯函数：吃 unknown 出规范形状，读面之外的形状校验也归它一处。
 */
export function normalizeStoryDirection(raw: unknown): StoryDirection {
    const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        presetText: typeof value.presetText === 'string' ? value.presetText : '',
        freeText: typeof value.freeText === 'string' ? value.freeText : '',
    };
}

/**
 * 预设列表 normalize（全局域）：非数组归空表；坏条目（缺 id/text 或类型
 * 不对）逐条剔除而非抛错——预设是用户可重建的辅助数据，不值得 Fail Fast
 * 打断组装。
 */
export function normalizeDirectionPresets(raw: unknown): DirectionPreset[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (p): p is DirectionPreset =>
            typeof p === 'object' && p !== null && typeof (p as DirectionPreset).id === 'string' && typeof (p as DirectionPreset).text === 'string',
    );
}

export const useStoryDirectionStore = defineStore('tt-story-direction', {
    state: () => ({
        /** 写穿计数：读透传 getter 的失效信号 */
        revision: 0,
    }),
    getters: {
        // 取值按域登记的类型是 StoryDirection，但存档与外部写坏的形状仍可能
        // 到场——归一由 normalize 面吃 unknown 逐字段守门（收紧只在 API 面）
        storyDirection(): StoryDirection {
            void this.revision;
            return normalizeStoryDirection(getChat(CHAT_STORY_DIRECTION_KEY));
        },
        directionPresets(): DirectionPreset[] {
            void this.revision;
            return normalizeDirectionPresets(getGlobal(GLOBAL_DIRECTION_PRESETS_KEY));
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
