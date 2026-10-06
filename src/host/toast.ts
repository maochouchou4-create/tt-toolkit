/**
 * 用户提示单点：主窗口 toastr 为宿主全局（index.html 顺序加载），缺席或
 * 调用异常时退回日志转发器——不静默丢失用户反馈（nav/persona 双份实现
 * 收敛于此，choice 生成失败面同享）。
 */

import { hostWindow } from './dom';
import { createTtlog } from './ttlog';

const log = createTtlog('host/toast');

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export function showToast(message: string, level: ToastLevel = 'info'): void {
    try {
        const t = hostWindow.toastr;
        const fn = t?.[level] ?? t?.info;
        if (fn) fn.call(t, message);
        else log.info(`toast-fallback ${level}: ${message}`);
    } catch {
        log.info(`toast-fallback ${level}: ${message}`);
    }
}
