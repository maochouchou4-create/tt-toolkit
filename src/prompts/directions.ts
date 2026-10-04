/**
 * 剧情走向标签集（方案 §7 P-走向：六选一起步，可增删）。
 *
 * 与 PoolConfig.rules 的分层（§2.3）：走向答「剧情往哪走」（chat 域，
 * 本模块）；rules 答「选项怎么写」（config 域，批C 导入旧数据）——
 * 两层概念不混。
 */
import type { StoryDirectionTag, StoryDirectionTagDef } from './types';

export const STORY_DIRECTION_TAG_DEFS: readonly StoryDirectionTagDef[] = [
    {
        id: 'advance',
        label: '推进主线',
        guidance: '让选项推动当前故事的主线剧情向前发展，优先给出能带来新进展的行动。',
    },
    {
        id: 'conflict',
        label: '制造冲突',
        guidance: '让选项引入或激化矛盾与冲突，制造张力，把剧情推向紧张局面。',
    },
    {
        id: 'warm',
        label: '日常温情',
        guidance: '让选项偏重日常互动与情感交流，节奏放缓，呈现人物关系中的温情面。',
    },
    {
        id: 'suspense',
        label: '悬疑加深',
        guidance: '让选项围绕未解之谜展开，加深悬念，鼓励探索与求证的行动。',
    },
    {
        id: 'foreshadow',
        label: '收束伏笔',
        guidance: '让选项呼应此前埋下的伏笔，使其逐步揭晓或回收，让既有线索产生回报。',
    },
    {
        id: 'free',
        label: '放任自流',
        guidance: '',
    },
] as const;

export function directionLabelOf(tag: StoryDirectionTag): string {
    return STORY_DIRECTION_TAG_DEFS.find(d => d.id === tag)?.label ?? tag;
}
