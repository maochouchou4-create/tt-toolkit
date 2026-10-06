/**
 * TT 宿主用户 persona 读写通道（persona 模块的宿主直连面）。
 *
 * 核实记录（D:\code\repos\TauriTavern\src，rewrite 施工时 HEAD）：
 * - personas.js:75 `export let user_avatar = ''`（当前选中头像 id 的
 *   live binding，setUserAvatar :153 内部赋值）。
 * - personas.js:548 `initPersona(avatarId, personaName, personaDescription,
 *   personaTitle, {silent,...})`：写 power_user.personas[avatarId] + 建
 *   persona 描述符 + saveSettingsDebounced + 非 silent emit PERSONA_CREATED。
 *   本通道建档走 silent:true（扩展不自造宿主 toast）。
 * - personas.js:864-881 宿主写回纪律（editPersonaTitle 实证）：写描述符 →
 *   getUserAvatars → saveSettingsDebounced → await eventSource.emit(
 *   event_types.PERSONA_UPDATED, avatarId)。
 * - personas.js:387-412 uploadUserAvatar 形态：fetch(default_user_avatar)→
 *   blob→File('avatar.png')→FormData(avatar + overwrite_name)→POST
 *   /api/avatars/upload（getRequestHeaders({omitContentType:true})，
 *   multipart boundary 由 fetch 自带）→json().path。
 * - personas.js:302 getUserAvatars()：返回头像文件名数组（ghost 键防御
 *   的真实文件名来源）。
 * - utils.js:2724 findPersona({name,allowAvatar,insensitive,
 *   preferCurrentPersona,quiet})：按名查宿主 persona。
 * - personas 真源口径：{头像文件id: 显示名}，描述在
 *   power_user.persona_descriptions[头像id].description，持久化由后端写进
 *   头像 PNG 元数据——头像文件不存在即报「no longer exists」，故新人设
 *   必须先经 /api/avatars/upload 落 PNG。
 *
 * emit 破例说明：本仓纪律是「扩展不反向 emit 宿主事件」（host/events.ts
 * 的 eventBus 只暴露 on/once）。但 persona 写回必须复刻宿主内部刷新行为
 * （personas.js:871 同款 PERSONA_UPDATED，否则宿主 persona 管理视图与镜像
 * 字段不刷新）。故本文件内部直接 import 宿主 eventSource 做 emit——破例
 * 封闭在本文件内，业务侧仍只读订阅（eventBus 面），不接触 emit。
 */

import { default_user_avatar, getRequestHeaders, saveSettingsDebounced } from '@sillytavern/script';
import { power_user as stPowerUser } from '@sillytavern/scripts/power-user';
import { eventSource as stEventSource, event_types as stEventTypes } from '@sillytavern/scripts/events';
import { getUserAvatars, initPersona, setUserAvatar, user_avatar } from '@sillytavern/scripts/personas';
import { findPersona } from '@sillytavern/scripts/utils';
import { createTtlog } from './ttlog';

const log = createTtlog('host/personas');

/** persona 描述符（power_user.persona_descriptions[avatarId] 的消费子集）。 */
export interface PersonaDescriptor {
    description: string;
    position: number;
    depth: number;
    role: number;
    lorebook: string;
    title: string;
}

/** power_user.personas（{头像文件id: 显示名}）的收窄读。 */
function personasRecord(): Record<string, string> {
    const raw = (stPowerUser as Record<string, unknown>).personas;
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [id, name] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof name === 'string') out[id] = name;
    }
    return out;
}

/** power_user.persona_descriptions 的收窄读（宽松形态容错）。 */
function personaDescriptions(): Record<string, PersonaDescriptor> {
    const raw = (stPowerUser as Record<string, unknown>).persona_descriptions;
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as Record<string, PersonaDescriptor>;
}

/** 当前选中头像 id（live binding 转发读）。 */
export function getCurrentAvatarId(): string {
    return typeof user_avatar === 'string' ? user_avatar : '';
}

/** 当前用户显示名（personas[user_avatar]；无选中/空名兜底 "User"）。 */
export function getUserDisplayName(): string {
    const name = personasRecord()[getCurrentAvatarId()];
    return typeof name === 'string' && name.trim() ? name : 'User';
}

/** 全量用户 persona 清单（ghost 键防御后的内存视图）。 */
export function listUserPersonas(): Array<{ avatarId: string; name: string }> {
    return Object.entries(personasRecord()).map(([avatarId, name]) => ({ avatarId, name }));
}

/**
 * 清理 personas 里指向不存在头像文件的幽灵键（旧版插件写入的脏数据）。
 * 纯内存删除＋saveSettingsDebounced，禁止对这些 id 调 /persona-delete——
 * 后端对不存在文件 404。磁盘快照为空的异常态宁漏勿误删（早退）。
 */
async function cleanGhostPersonaKeys(): Promise<void> {
    try {
        const files = new Set((await getUserAvatars(false)) as unknown[]);
        if (files.size === 0) return;
        const personasMap = (stPowerUser as Record<string, unknown>).personas as Record<string, unknown> | undefined;
        const descriptionsMap = (stPowerUser as Record<string, unknown>).persona_descriptions as Record<string, unknown> | undefined;
        if (!personasMap && !descriptionsMap) return;
        let removed = false;
        for (const id of Object.keys(personasRecord())) {
            if (!files.has(id)) {
                delete personasMap?.[id];
                delete descriptionsMap?.[id];
                removed = true;
            }
        }
        if (removed) saveSettingsDebounced();
    } catch (err) {
        log.warn('清理人设幽灵键失败', err);
    }
}

/**
 * 新建头像 persona：复制宿主默认头像上传（落 PNG 才能持久化描述），
 * 再 initPersona 建档（silent——扩展不自造宿主 toast）。
 */
async function createAvatarPersona(displayName: string, description: string): Promise<string> {
    // 命名口径与宿主 uploadUserAvatar 同款：时间戳 + 显示名安全字符 + .png
    const preferredId = `${Date.now()}-${displayName.replace(/[^a-zA-Z0-9]/g, '')}.png`;
    const blob = await (await fetch(default_user_avatar)).blob();
    // {type:'image/png'} 与宿主 uploadUserAvatar（personas.js:390）逐字段
    // 一致：漏 type 时 FormData 分片无 Content-Type，个别代理/网关会拒收
    const file = new File([blob], 'avatar.png', { type: 'image/png' });
    const form = new FormData();
    form.append('avatar', file);
    form.append('overwrite_name', preferredId);
    const res = await fetch('/api/avatars/upload', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: form,
    });
    if (!res.ok) throw new Error(`头像上传失败 (${res.status})`);
    const json = (await res.json()) as { path?: string };
    const avatarId = json.path || preferredId;
    await getUserAvatars(false);
    await initPersona(avatarId, displayName, description, '', { silent: true });
    return avatarId;
}

/**
 * 人设写回（按名 upsert，PersonaWeaver fork 迁移平移）：
 * 先清幽灵键再查重——旧版插件写入的幽灵键若仍在内存，findPersona 会命中它
 * 并走「更新已存在」分支，该分支对无头像文件的 id 必然保存失败。
 *
 * 已存在分支写回纪律（personas.js:864-881 宿主内部同序）：
 * 写 persona_descriptions[avatarId].description →（选中态时刷
 * power_user.persona_description 镜像）→ saveSettingsDebounced →
 * emit PERSONA_UPDATED → 未选中时 setUserAvatar 静默切换。
 */
export async function upsertPersona(displayName: string, description: string): Promise<{ avatarId: string; created: boolean }> {
    await cleanGhostPersonaKeys();
    const existing = findPersona({ name: displayName, allowAvatar: false, preferCurrentPersona: false }) as { avatar?: unknown } | null;
    const existingAvatarId = existing && typeof existing.avatar === 'string' ? existing.avatar : null;

    if (existingAvatarId) {
        // 按名查到的人设名字本就一致，此处不写 name（半截改名会与 name1 脱钩，改名应走宿主流程）
        const descriptor = (personaDescriptions()[existingAvatarId] ??= { description: '', position: 0, depth: 2, role: 0, lorebook: '', title: '' });
        descriptor.description = description;
        if (getCurrentAvatarId() === existingAvatarId) {
            (stPowerUser as Record<string, unknown>).persona_description = description;
        }
        saveSettingsDebounced();
        // emit 破例：复刻宿主内部刷新行为（见文件头），业务侧仍只读订阅
        await stEventSource.emit(stEventTypes.PERSONA_UPDATED, existingAvatarId);
        if (getCurrentAvatarId() !== existingAvatarId) {
            await setUserAvatar(existingAvatarId, { toastPersonaNameChange: false });
        }
        return { avatarId: existingAvatarId, created: false };
    }

    const avatarId = await createAvatarPersona(displayName, description);
    return { avatarId, created: true };
}
