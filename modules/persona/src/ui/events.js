// 全部事件绑定的注册（接线层）。按视图内拆是后置清单——闭包共享状态需先重构，本批只整体搬移。
// addPersonaButton 与 bindEvents 同文件：bindEvents 将其注册为 APP_READY/MOVABLE_PANELS_RESET 处理器，须同模块作用域。
import { getContext } from "../../../../../../../extensions.js";
import { store, saveData, loadState, saveState } from "../state.js";
import { getActivePersonaDescription, getUserDisplayName } from "../st-data.js";
import { runGeneration, collectContextData, getPresetHintText } from "../generation.js";
import { upsertPersona, syncPersonaToWorldInfo, getAllWorldBooks, getWorldBookEntries } from "../world-info.js";
import { renderDiffComparison, assembleDiffResult } from "../diff.js";
import { fetchModels, testConnection, clampTimeout } from "../api.js";
import { TEXT } from "../strings.js";
import { log as logInfo, error as logError } from "../log.js";
import { renderApiProfiles } from "./render.js";
import { renderWiBooks } from "./world-book-widget.js";
import { openCreatorPopup } from "./panel.js";

const BUTTON_ID = 'pw_persona_tool_btn';

// 生成/润色互斥与润色记忆是本模块私有运行态（历史误挂 store，无跨模块消费方）
let isProcessing = false;
let lastRefineRequest = "";

// 按钮忙碌态：快照原 html 换入忙碌图标，返回恢复函数供 try/finally 收尾复位。
const withButtonSpinner = ($btn, busyHtml) => {
    const idleHtml = $btn.html();
    $btn.html(busyHtml);
    return () => $btn.html(idleHtml);
};

// 结果框应用三连（生成/载入共用收尾）：写结果→展开→折叠需求框→热存→触发自适应高度。
const applyGeneratedResult = (text) => {
    $('#pw-result-text').val(text);
    $('#pw-result-area').fadeIn();
    $('#pw-request').addClass('minimized');
    saveCurrentState();
    $('#pw-result-text').trigger('input');
};

// 载入遮罩关闭动画（打开遮罩的三处流程共用收尾）。
const closeLoadOverlay = () => $('#pw-load-overlay').animate({opacity: 0}, 200, function() { $(this).css('display', 'none'); });

const forcePaint = () => new Promise(resolve => setTimeout(resolve, 50));

// 编辑现场与 API 表单的防抖热存（1.2s 静默期）：写 userContext 与 localConfig（含自动热保存到当前选中配置）。
let saveTimeout;
const saveCurrentState = () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        // 面板关闭后触发的事件残留不得把空值写进存档
        if ($('#pw-request').length === 0) return;

        const curReq = $('#pw-request').val();
        const curRes = $('#pw-result-text').val();
        const hasRes = $('#pw-result-area').is(':visible');

        store.userContext.request = curReq;
        store.userContext.result = curRes;
        store.userContext.hasResult = hasRes;

        saveData();

        // Check if API settings exist before saving legacy
        if ($('#pw-api-url').length > 0) {
            const currentSaved = loadState();
            let currentLc = currentSaved.localConfig || {};

            currentLc.apiSource = $('#pw-api-source').val();
            currentLc.indepApiUrl = $('#pw-api-url').val();
            currentLc.indepApiKey = $('#pw-api-key').val();
            currentLc.indepApiModel = $('#pw-api-model-select').val();
            const timeoutInput = parseInt($('#pw-indep-timeout').val(), 10);
            if (timeoutInput > 0) currentLc.indepTimeout = clampTimeout(timeoutInput);
            const $streamEl = $('#pw-indep-stream');
            if ($streamEl.length) currentLc.indepStream = $streamEl.prop('checked');
            // max_tokens 现在由 resolveMaxTokens() 按模型名自动推断，不再有 UI 可配置
            currentLc.extraBooks = store.extraBooks;

            // --- 自动热保存至当前选中配置 ---
            const activeId = $('#pw-api-profile-select').val();
            const currentName = $('#pw-api-profile-name').val() || "未命名配置";

            if (activeId && activeId !== 'custom') {
                if (!currentLc.apiProfiles) currentLc.apiProfiles =[];
                const prof = currentLc.apiProfiles.find(p => p.id === activeId);
                if (prof) {
                    prof.name = currentName;
                    prof.url = currentLc.indepApiUrl;
                    prof.key = currentLc.indepApiKey;
                    prof.model = currentLc.indepApiModel;

                    $(`#pw-api-profile-select option[value="${activeId}"]`).text(currentName);
                }
                currentLc.activeApiProfileId = activeId;
            } else {
                currentLc.activeApiProfileId = 'custom';
            }

            currentSaved.localConfig = currentLc;
            saveState(currentSaved);
        }
    }, 1200);
};

// 生成 / 润色 / 重 Roll 三处共用的请求配置构造（单一事实源，避免三份字段集各写一遍后漂移）。
// 变动字段（mode / request / currentText）由调用点传入，上下文与 API 设置统一从 DOM 读取。
// thinkingEffort 只做透传，是否注入请求体由 generation.js 按端点能力决定。
const buildApiConfig = (contextData, fields) => ({
    ...fields,
    wiText: contextData.wi,
    greetingsText: contextData.greetings,
    apiSource: $('#pw-api-source').val(),
    indepApiUrl: $('#pw-api-url').val(),
    indepApiKey: $('#pw-api-key').val(),
    indepApiModel: $('#pw-api-source').val() === 'independent' ? $('#pw-api-model-select').val() : null,
    thinkingEffort: $('#pw-thinking-effort').val()
});


// API 域：配置存为/切换/删除、请求超时与思考强度、取模型与连通测试、编辑现场热存绑定。
function bindApiProfileEvents() {
    // 1. 保存为配置：把当前表单（含命名框）整体收进新配置并选中，不清空表单——
    //    旧「新建空白」语义下未选中配置时填的内容没有保存路径，且清空会砸掉已填字段。
    //    已选配置的后续改动由 saveCurrentState 的自动热保存写回，此处只负责从无到有。
    $(document).on('click.pw', '#pw-api-profile-add', function(e) {
        e.preventDefault();
        
        const savedState = loadState();
        let lc = savedState.localConfig || {};
        if (!lc.apiProfiles) lc.apiProfiles =[];
        
        const newId = Date.now().toString();
        const newName = $('#pw-api-profile-name').val().trim() || "新配置 " + (lc.apiProfiles.length + 1);

        lc.apiProfiles.push({
            id: newId,
            name: newName,
            url: $('#pw-api-url').val(),
            key: $('#pw-api-key').val(),
            model: $('#pw-api-model-select').val() || ''
        });
        lc.activeApiProfileId = newId;
        savedState.localConfig = lc;
        saveState(savedState);

        renderApiProfiles();
        toastr.success(TEXT.TOAST_PROFILE_SAVED(newName));
    });

    // 2. 切换配置
    $(document).on('change.pw', '#pw-api-profile-select', function() {
        const activeId = $(this).val();
        const savedState = loadState();
        let lc = savedState.localConfig || {};

        if (activeId === 'custom') {
            lc.activeApiProfileId = 'custom';
            $('#pw-api-profile-name').val('');
            savedState.localConfig = lc;
            saveState(savedState);
            return;
        }

        if (lc.apiProfiles) {
            const prof = lc.apiProfiles.find(p => p.id === activeId);
            if (prof) {
                $('#pw-api-profile-name').val(prof.name);
                $('#pw-api-url').val(prof.url);
                $('#pw-api-key').val(prof.key);
                
                if ($('#pw-api-model-select option[value="'+prof.model+'"]').length === 0 && prof.model) {
                    $('#pw-api-model-select').append(`<option value="${prof.model}">${prof.model}</option>`);
                }
                $('#pw-api-model-select').val(prof.model);

                lc.activeApiProfileId = activeId;
                lc.indepApiUrl = prof.url;
                lc.indepApiKey = prof.key;
                lc.indepApiModel = prof.model;
                savedState.localConfig = lc;
                saveState(savedState);
            }
        }
    });

    // 3. 删除配置
    $(document).on('click.pw', '#pw-api-profile-delete', function(e) {
        e.preventDefault();
        const activeId = $('#pw-api-profile-select').val();
        if (!activeId || activeId === 'custom') return toastr.warning(TEXT.TOAST_SELECT_PROFILE);
        if (!confirm("确定要删除当前选中的 API 配置吗？")) return;

        const savedState = loadState();
        let lc = savedState.localConfig || {};
        if (lc.apiProfiles) {
            lc.apiProfiles = lc.apiProfiles.filter(p => p.id !== activeId);
            lc.activeApiProfileId = lc.apiProfiles.length > 0 ? lc.apiProfiles[0].id : 'custom';
            savedState.localConfig = lc;
            saveState(savedState);
            
            renderApiProfiles();
            $('#pw-api-profile-select').trigger('change.pw'); 
            toastr.success(TEXT.TOAST_PROFILE_DELETED);
        }
    });

    $(document).on('input.pw change.pw', '#pw-request, #pw-result-text, #pw-wi-toggle, #pw-indep-stream, .pw-input, .pw-select', saveCurrentState);

    $(document).on('change.pw', '#pw-api-source', function () { $('#pw-indep-settings').toggle($(this).val() === 'independent'); });

    // 思考强度是请求级参数、与 API 来源无关，单独持久化（不进 saveCurrentState 的独立 API 分支）
    $(document).on('change.pw', '#pw-thinking-effort', function () {
        const savedState = loadState();
        savedState.localConfig = { ...(savedState.localConfig || {}), thinkingEffort: $(this).val() };
        saveState(savedState);
    });

    $(document).on('click.pw', '#pw-api-fetch', async function (e) {
        e.preventDefault();
        const url = $('#pw-api-url').val();
        const key = $('#pw-api-key').val();
        const $btn = $(this).find('i').addClass('fa-spin');
        try {
            // 协议知识（形态判定/base 归一/候选端点循环）全部在 api.js，UI 只管表单与呈现
            const models = await fetchModels(url, key);
            const $select = $('#pw-api-model-select').empty();
            models.forEach(m => $select.append(`<option value="${m}">${m}</option>`));
            if (models.length > 0) $select.val(models[0]);
            toastr.success(TEXT.TOAST_MODELS_LOADED(models.length));
        } catch (e) { toastr.error(e.message); }
        finally { $btn.removeClass('fa-spin'); }
    });

    $(document).on('click.pw', '#pw-api-test', async function (e) {
        e.preventDefault();
        const url = $('#pw-api-url').val();
        const key = $('#pw-api-key').val();
        const model = $('#pw-api-model-select').val();
        const $btn = $(this);
        const restoreBtn = withButtonSpinner($btn, '<i class="fas fa-spinner fa-spin"></i>');
        try {
            const res = await testConnection(url, key, model);
            if (res.ok) toastr.success(TEXT.TOAST_CONN_OK);
            else toastr.error(TEXT.TOAST_CONN_STATUS(res.status));
        } catch (e) { toastr.error(TEXT.TOAST_CONN_FAIL); }
        finally { restoreBtn(); }
    });
}

// 预设与开场白域：预设下拉记忆、开场白选择与预览折叠。
function bindPresetGreetingsEvents() {
    $(document).on('change.pw', '#pw-preset-select', function() {
        const val = $(this).val();
        store.uiStateCache.generationPreset = val;
        saveData();
        $('#pw-preset-hint').text(getPresetHintText(val));
    });

    $(document).on('change.pw', '#pw-greetings-select', function() {
        const idx = $(this).val();
        const $preview = $('#pw-greetings-preview');
        const $toggleBtn = $('#pw-greetings-toggle-bar');
        
        if (idx === "") {
            $preview.slideUp(200);
            $toggleBtn.hide();
        } else if (store.currentGreetingsList[idx]) {
            $preview.val(store.currentGreetingsList[idx].content);
            $preview.slideDown(200); // Slide direct
            $toggleBtn.show().html('<i class="fa-solid fa-angle-up"></i> 收起预览');
        }
    });

    $(document).on('click.pw', '#pw-greetings-toggle-bar', function() {
        const $preview = $('#pw-greetings-preview');
        if ($preview.is(':visible')) {
            $preview.slideUp(200);
            $(this).html('<i class="fa-solid fa-angle-down"></i> 展开预览');
        } else {
            $preview.slideDown(200);
            $(this).html('<i class="fa-solid fa-angle-up"></i> 收起预览');
        }
    });
}

// 编辑器域：复制、tab 切换、划词浮窗、自适应高度、双框焦点切换。
function bindEditorEvents() {
$(document).on('click.pw', '#pw-copy-persona', function() {
        const text = $('#pw-result-text').val();
        if(!text) return toastr.warning(TEXT.TOAST_NOTHING_TO_COPY);
        navigator.clipboard.writeText(text);
        toastr.success(TEXT.TOAST_COPIED);
    });

    $(document).on('click.pw', '.pw-tab', function () {
        $('.pw-tab').removeClass('active'); $(this).addClass('active');
        $('.pw-view').removeClass('active');
        $(`#pw-view-${$(this).data('tab')}`).addClass('active');
    });

    let selectionTimeout;
    const checkSelection = () => {
        clearTimeout(selectionTimeout);
        selectionTimeout = setTimeout(() => {
            const activeEl = document.activeElement;
            if (!activeEl || !activeEl.id.startsWith('pw-result-text')) return;
            const hasSelection = activeEl.selectionStart !== activeEl.selectionEnd;
            const $btn = $('#pw-float-quote-btn');
            if (hasSelection) {
                if (!$btn.is(':visible')) $btn.stop(true, true).fadeIn(200).css('display', 'flex');
            } else {
                if ($btn.is(':visible')) $btn.stop(true, true).fadeOut(200);
            }
        }, 100);
    };
    $(document).on('touchend mouseup keyup', '#pw-result-text', checkSelection);

    $(document).on('mousedown.pw', '#pw-float-quote-btn', function (e) {
        e.preventDefault(); e.stopPropagation();
        const activeEl = document.activeElement;
        if (!activeEl) return;
        const start = activeEl.selectionStart;
        const end = activeEl.selectionEnd;
        const selectedText = activeEl.value.substring(start, end).trim();
        if (selectedText) {
            let $input = $('#pw-refine-input');
            if ($input && $input.length) {
                const cur = $input.val();
                const newText = `对 "${selectedText}" 的修改意见为：`;
                $input.val(cur ? cur + '\n' + newText : newText).focus();
                activeEl.setSelectionRange(end, end); 
                $('#pw-float-quote-btn').fadeOut(100);
            }
        }
    });

    let _ahTimer = null;
    const adjustHeight = (el) => {
        if (_ahTimer) return;
        _ahTimer = requestAnimationFrame(() => {
            _ahTimer = null;
            el.style.height = 'auto';
            el.style.height = (el.scrollHeight) + 'px';
        });
    };
    $(document).on('input.pw', '.pw-auto-height', function () { adjustHeight(this); });

    // --- 文本框焦点切换：点击哪个展开哪个 ---
    $(document).on('focus.pw', '#pw-request', function() {
        if ($('#pw-result-area').is(':visible')) {
            $(this).removeClass('minimized');
            $('#pw-result-text').addClass('minimized');
        }
    });
    $(document).on('focus.pw', '#pw-result-text', function() {
        if ($('#pw-result-area').is(':visible')) {
            $(this).removeClass('minimized');
            $('#pw-request').addClass('minimized');
        }
    });
}

// Diff 润色域：视图模式切换、内联取舍、润色与重 Roll、确认/取消。
function bindDiffEvents() {
// --- Diff View Logic (Sub-view Mode Switching) ---
    $(document).on('click.pw', '.pw-diff-mode-btn', function () {
        const $list = $('#pw-diff-merge-list');
        if ($(this).hasClass('active')) {
            $(this).removeClass('active');
            $list.removeClass('pw-diff-mode-new pw-diff-mode-old pw-diff-mode-final').addClass('pw-diff-mode-all');
            $('#pw-diff-hint').show();
            return;
        }
        $('.pw-diff-mode-btn').removeClass('active');
        $(this).addClass('active');
        const mode = $(this).data('mode');
        $list.removeClass('pw-diff-mode-all pw-diff-mode-new pw-diff-mode-old pw-diff-mode-final').addClass('pw-diff-mode-' + mode);
        $('#pw-diff-hint').hide();
    });

    $(document).on('mousedown.pw', '.pw-idiff-old', function () {
        if (!$('#pw-diff-merge-list').hasClass('pw-diff-mode-all')) return;
        if ($(this).hasClass('active')) return;
        const idx = $(this).data('idx');
        store.currentDiffBlocks[idx].active = 'old';
        $(this).addClass('active').removeClass('inactive').attr('contenteditable', 'true');
        $(this).siblings('.pw-idiff-new').addClass('inactive').removeClass('active').attr('contenteditable', 'false');
    });
    $(document).on('mousedown.pw', '.pw-idiff-new', function () {
        if (!$('#pw-diff-merge-list').hasClass('pw-diff-mode-all')) return;
        if ($(this).hasClass('active')) return;
        const idx = $(this).data('idx');
        store.currentDiffBlocks[idx].active = 'new';
        $(this).addClass('active').removeClass('inactive').attr('contenteditable', 'true');
        $(this).siblings('.pw-idiff-old').addClass('inactive').removeClass('active').attr('contenteditable', 'false');
    });

    // 容器级 input：跨 span 编辑后统一回写到 store.currentDiffBlocks
    $(document).on('input.pw', '#pw-diff-merge-list', function () {
        $(this).find('.pw-idiff-equal').each(function () {
            const idx = $(this).data('idx');
            if (idx !== undefined && store.currentDiffBlocks[idx]) store.currentDiffBlocks[idx].value = $(this).text();
        });
        $(this).find('.pw-idiff-old.active').each(function () {
            const idx = $(this).data('idx');
            if (idx !== undefined && store.currentDiffBlocks[idx]) store.currentDiffBlocks[idx].oldText = $(this).text();
        });
        $(this).find('.pw-idiff-new.active').each(function () {
            const idx = $(this).data('idx');
            if (idx !== undefined && store.currentDiffBlocks[idx]) store.currentDiffBlocks[idx].newText = $(this).text();
        });
    });

    // Refine (Persona)
   // ================== 1. 润色按钮逻辑 (主界面) ==================
    $(document).on('click.pw', '#pw-btn-refine', async function (e) {
        e.preventDefault();
        if (isProcessing) return;
        isProcessing = true;

        const refineReq = $('#pw-refine-input').val();
        if (!refineReq) {
            toastr.warning(TEXT.TOAST_REFINE_EMPTY);
            isProcessing = false;
            return;
        }
        
        lastRefineRequest = refineReq;

        const oldText = $('#pw-result-text').val();
        const $btn = $(this).find('i').removeClass('fa-magic').addClass('fa-spinner fa-spin');
        
        await forcePaint();

        try {
            const contextData = await collectContextData();
            const config = buildApiConfig(contextData, {
                mode: 'refine',
                request: refineReq,
                currentText: oldText
            });
            const responseText = await runGeneration(config);

            // 复用提取出来的渲染函数
            renderDiffComparison(oldText, responseText);

            $('#pw-diff-overlay').data('source', 'persona');

            $('#pw-diff-overlay').fadeIn();
            $('#pw-refine-input').val(''); // 清空输入框
        } catch (e) { 
            logError(e);
            toastr.error(TEXT.TOAST_REFINE_FAIL(e.message)); 
        } finally { 
            $btn.removeClass('fa-spinner fa-spin').addClass('fa-magic');
            isProcessing = false;
        }
    });

    // ================== 2. 重 Roll 按钮逻辑 (Diff界面内) ==================
    $(document).on('click.pw', '#pw-diff-reroll', async function (e) {
        e.preventDefault();
        if (isProcessing) return;
        if (!lastRefineRequest) {
            toastr.warning(TEXT.TOAST_NO_LAST_REQUEST);
            return;
        }

        isProcessing = true;
        const $btn = $(this);
        const restoreBtn = withButtonSpinner($btn, '<i class="fa-solid fa-spinner fa-spin"></i> 生成中...');

        // 只要没点确认保存，旧文本就一直是 result-text 里的内容
        const oldText = $('#pw-result-text').val();

        try {
            const contextData = await collectContextData();
            const config = buildApiConfig(contextData, {
                mode: 'refine',
                request: lastRefineRequest,
                currentText: oldText
            });
            
            const responseText = await runGeneration(config);

            // 复用渲染函数，原地刷新 Diff 界面
            renderDiffComparison(oldText, responseText);
            
            toastr.success(TEXT.TOAST_REROLLED);

        } catch (e) {
            logError(e);
            toastr.error(TEXT.TOAST_REROLL_FAIL(e.message));
        } finally {
            restoreBtn();
            isProcessing = false;
        }
    });

    $(document).on('click.pw', '#pw-diff-confirm', function () {
        const finalContent = assembleDiffResult();
        $('#pw-result-text').val(finalContent).trigger('input');
        $('#pw-diff-overlay').fadeOut();
        saveCurrentState();
        toastr.success(TEXT.TOAST_APPLIED);
    });

    $(document).on('click.pw', '#pw-diff-cancel', () => $('#pw-diff-overlay').fadeOut());
}

// 生成与落库域：生成 User 设定、写回世界书、覆盖当前人设、清空。
function bindGenerationEvents() {
// Generate Persona
    $(document).on('click.pw', '#pw-btn-gen', async function (e) {
        e.preventDefault();
        
        if (isProcessing) return;
        isProcessing = true;

        // 需求已改为可选（额外需求）：空需求＝纯全自动链，由 curator 按世界书自行策展
        const req = $('#pw-request').val();
        const $btn = $(this);
        $btn.prop('disabled', true);
        const restoreBtn = withButtonSpinner($btn, '<i class="fas fa-spinner fa-spin"></i> 生成中...');
        
        await forcePaint();
        
        $('#pw-refine-input').val('');
        $('#pw-result-text').val('');

        try {
            const contextData = await collectContextData();
            const config = buildApiConfig(contextData, {
                mode: 'initial',
                request: req || '',
                currentText: ''
            });
            const text = await runGeneration(config);
            applyGeneratedResult(text);
        } catch (e) { 
            logError(e);
            toastr.error(e.message); 
        } finally {
            $btn.prop('disabled', false);
            restoreBtn();
            isProcessing = false;
        }
    });

    $(document).on('click.pw', '#pw-btn-save-wi', async function () {
        const content = $('#pw-result-text').val();
        if (!content) return toastr.warning(TEXT.TOAST_EMPTY_FOR_SAVE);
        const name = getUserDisplayName();
        await syncPersonaToWorldInfo(name, content);
    });

    $(document).on('click.pw', '#pw-btn-apply', async function () {
        const content = $('#pw-result-text').val();
        if (!content) return toastr.warning(TEXT.TOAST_EMPTY_RESULT);
        const name = getUserDisplayName();
        try {
            await upsertPersona(name, content);
        } catch (e) {
            logError(e);
            return toastr.error(TEXT.TOAST_SAVE_FAIL(e.message));
        }
        toastr.success(TEXT.TOAST_SAVE_SUCCESS(name));
        $('.popup_close').click();
    });

    $(document).on('click.pw', '#pw-clear', function () {
        if (confirm("确定清空？")) {
            $('#pw-request').val('').removeClass('minimized');
            $('#pw-result-area').hide();
            $('#pw-result-text').val('');
            saveCurrentState();
        }
    });
}

// 载入遮罩域：关闭、载入已有人设（User 人设/世界书条目）、追加书目。
function bindLoadOverlayEvents() {
$(document).on('click.pw', '#pw-load-overlay-close', closeLoadOverlay);

    $(document).on('click.pw', '#pw-btn-load-current', async function() {
        const $content = $('#pw-load-overlay-content');

        const applyContent = (content) => {
            if (!content) return toastr.warning(TEXT.TOAST_NO_VALID_CONTENT);
            if ($('#pw-result-text').val() && !confirm("当前结果框已有内容，确定要覆盖吗？")) return;
            applyGeneratedResult(content);
            closeLoadOverlay();
            toastr.success(TEXT.TOAST_LOAD_CURRENT);
        };

        const showWiSelector = async (filterKeyword) => {
            const allBooks = await getAllWorldBooks();
            if (allBooks.length === 0) return toastr.warning(TEXT.TOAST_NO_WI_BOOKS);

            let allEntries = [];
            for (const bookName of allBooks) {
                const entries = await getWorldBookEntries(bookName);
                entries.forEach(e => {
                    if (e.content) allEntries.push({ book: bookName, ...e });
                });
            }

            if (filterKeyword) {
                const kw = filterKeyword.toLowerCase();
                const filtered = allEntries.filter(e =>
                    (e.displayName || '').toLowerCase().includes(kw) ||
                    (e.content || '').toLowerCase().includes(kw)
                );
                if (filtered.length > 0) allEntries = filtered;
            }

            if (allEntries.length === 0) { closeLoadOverlay(); return toastr.warning(TEXT.TOAST_NO_WI_ENTRIES); }

            const optionsHtml = allEntries.map((e, i) =>
                `<option value="${i}">[${e.book}] ${e.displayName}</option>`
            ).join('');

            $content.html(`
                <div style="display:flex; flex-direction:column; gap:8px;">
                    <select id="pw-wi-load-select" class="pw-input" style="width:100%;">
                        ${optionsHtml}
                    </select>
                    <div id="pw-wi-load-preview" style="max-height:35vh; overflow-y:auto; padding:8px; background:var(--pw-paper-bg); border:1px solid var(--pw-border); border-radius:6px; font-size:0.85em; white-space:pre-wrap; line-height:1.5; text-align:left; color:var(--pw-text-main);"></div>
                    <button class="pw-btn gen" id="pw-wi-load-confirm" style="flex-shrink:0;"><i class="fa-solid fa-check"></i> 载入选中条目</button>
                </div>`);

            $('#pw-wi-load-select').on('change', function() {
                const idx = parseInt($(this).val());
                if (!isNaN(idx) && allEntries[idx]) {
                    $('#pw-wi-load-preview').text(allEntries[idx].content);
                }
            }).val('0').trigger('change');

            $('#pw-wi-load-confirm').on('click', function() {
                const idx = parseInt($('#pw-wi-load-select').val());
                if (!isNaN(idx) && allEntries[idx]) {
                    applyContent(allEntries[idx].content);
                }
            });
        };

        const userPersona = getActivePersonaDescription();
        const hasUserPersona = !!userPersona;

        $('#pw-load-overlay-title').text('载入已有人设');
        $content.html(`
            <div style="display:flex; flex-direction:column; gap:10px;">
                <span style="opacity:0.7; font-size:0.9em;">选择载入来源</span>
                <div style="display:flex; gap:8px; width:100%;">
                    <button class="pw-btn primary pw-load-choice" data-choice="user" style="flex:1; padding:10px; font-size:0.95em;${!hasUserPersona ? ' opacity:0.4; cursor:not-allowed;' : ''}" ${!hasUserPersona ? 'disabled title="未检测到当前 User 人设"' : ''}>
                        <i class="fa-solid fa-user"></i> User 人设
                    </button>
                    <button class="pw-btn primary pw-load-choice" data-choice="worldbook" style="flex:1; padding:10px; font-size:0.95em;">
                        <i class="fa-solid fa-book-atlas"></i> 世界书条目
                    </button>
                </div>
            </div>`);

        $('#pw-load-overlay').css('display', 'flex').css('opacity', 0).animate({opacity: 1}, 200);

        $content.find('.pw-load-choice').on('click', async function() {
            const choice = $(this).data('choice');
            if (choice === 'user') {
                applyContent(userPersona);
            } else {
                $content.html('<div style="text-align:center; padding:20px; opacity:0.6;"><i class="fas fa-spinner fa-spin"></i> 正在读取世界书...</div>');
                const userName = getUserDisplayName('');
                await showWiSelector(userName);
            }
        });
    });

    $(document).on('click.pw', '#pw-wi-add', () => { const val = $('#pw-wi-select').val(); if (val && !store.extraBooks.includes(val)) { store.extraBooks.push(val); renderWiBooks(); } });
}

export function bindEvents() {
    if (window.stPersonaWeaverBound) return;
    window.stPersonaWeaverBound = true;

    logInfo("Binding Events (Standard)...");

    const context = getContext();
    if (context && context.eventSource) {
        context.eventSource.on(context.eventTypes.APP_READY, addPersonaButton);
        context.eventSource.on(context.eventTypes.MOVABLE_PANELS_RESET, addPersonaButton);
    }
    // 对外契约：控制台/外部脚本经 window.openPersonaWeaver 直接唤起生成面板
    window.openPersonaWeaver = openCreatorPopup;

    bindApiProfileEvents();
    bindPresetGreetingsEvents();
    bindEditorEvents();
    bindDiffEvents();
    bindGenerationEvents();
    bindLoadOverlayEvents();
}

export function addPersonaButton() {
    const container = $('.persona_controls_buttons_block');
    if (container.length === 0 || $(`#${BUTTON_ID}`).length > 0) return;
    const newButton = $(`<div id="${BUTTON_ID}" class="menu_button fa-solid fa-wand-magic-sparkles interactable" title="${TEXT.BTN_TITLE}" tabindex="0" role="button"></div>`);
    newButton.on('click', openCreatorPopup);
    container.prepend(newButton);
}
