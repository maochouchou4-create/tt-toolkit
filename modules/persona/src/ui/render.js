// UI 渲染函数簇：各视图的 DOM 输出（渲染后由 events/panel 接线），与 events.js（输入接线）分离。
// 世界书选择自洽控件（渲染＋接线＋持久化一体）独立成 world-book-widget.js。
import { getContext } from "../../../../../../../extensions.js";
import { log as logInfo, warn as logWarn } from "../log.js";
import { store, loadState } from "../state.js";
import { getCharacterGreetingsList } from "../st-data.js";

export function autoBindGreetings() {
    try {
        const msg = getContext().chat?.[0];
        const swipeId = msg?.swipe_id;
        if (swipeId !== undefined && swipeId !== null) {
            if ($(`#pw-greetings-select option[value="${swipeId}"]`).length > 0) {
                $('#pw-greetings-select').val(swipeId);

                // 默认收起：打开面板不抢输入焦点；有结果时由 userContext.hasResult 在初始化时恢复
                if (store.currentGreetingsList[swipeId]) {
                    $('#pw-greetings-preview').val(store.currentGreetingsList[swipeId].content).hide();
                    $('#pw-greetings-toggle-bar').show().html('<i class="fa-solid fa-angle-down"></i> 展开预览');
                }

                logInfo(`Auto-bound greetings to Swipe #${swipeId}`);
            }
        }
    } catch (e) {
        logWarn("Auto-bind greetings failed:", e);
    }
}

export function renderApiProfiles() {
    const savedState = loadState();
    const lc = savedState.localConfig || {};
    const profiles = lc.apiProfiles ||[];
    const $select = $('#pw-api-profile-select');
    if ($select.length === 0) return;
    $select.empty();

    if (profiles.length === 0) {
        $select.append('<option value="custom">-- 暂无已保存配置 --</option>');
    } else {
        profiles.forEach(p => {
            $select.append(`<option value="${p.id}">${p.name}</option>`);
        });
        $select.append('<option value="custom">-- 临时使用 (不保存) --</option>');
    }

    if (lc.activeApiProfileId && $select.find(`option[value="${lc.activeApiProfileId}"]`).length > 0) {
        $select.val(lc.activeApiProfileId);
    } else if (profiles.length > 0) {
        $select.val(profiles[0].id);
    } else {
        $select.val('custom');
    }
}

export const renderGreetingsList = () => {
    const list = getCharacterGreetingsList();
    store.currentGreetingsList = list;
    const $select = $('#pw-greetings-select').empty();
    $select.append('<option value="">(不使用开场白)</option>');
    list.forEach((item, idx) => {
        $select.append(`<option value="${idx}">${item.label}</option>`);
    });
};
