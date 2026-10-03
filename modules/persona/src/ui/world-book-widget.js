// 世界书选择自洽控件：书目渲染＋13 处交互接线＋钉选持久化一体，状态在 store 书目字段。
// 独立成文件——render.js 其余函数是纯输出（渲染后由 events/panel 接线），本控件例外。
import { store } from "../state.js";
import { TEXT } from "../strings.js";
import { getContextWorldBooks, getWorldBookEntries, loadWiSelection, saveWiSelection, savePinnedBooks, getPosAbbr } from "../world-info.js";

export const renderWiBooks = async () => {
    const container = $('#pw-wi-container').empty();
    const baseBooks = await getContextWorldBooks();
    const allBooks = [...new Set([...baseBooks, ...store.extraBooks])];
    
    if (allBooks.length === 0) { 
        container.html('<div style="opacity:0.6; padding:10px; text-align:center;">此角色未绑定世界书，请在“世界书”标签页手动添加或在酒馆主界面绑定。</div>'); 
        return; 
    }

    for (const book of allBooks) {
        const isBound = baseBooks.includes(book);
        const isPinned = store.pinnedBooks.includes(book);
        
        let statusLabel = '';
        if (isBound) statusLabel = '<span class="pw-bound-status">(已绑定)</span>';
        else if (isPinned) statusLabel = '<span class="pw-bound-status" style="color:var(--SmartThemeQuoteColor);">(已固定)</span>';

        const pinIcon = !isBound
            ? `<i class="fa-solid fa-thumbtack pw-pin-book-icon" title="${isPinned ? '取消固定' : '固定此世界书（跨角色卡保留）'}" style="cursor:pointer; margin-right:6px; opacity:${isPinned ? '1' : '0.4'}; color:${isPinned ? 'var(--SmartThemeQuoteColor)' : 'inherit'};"></i>`
            : '';
        const removeIcon = !isBound ? '<i class="fa-solid fa-times remove-book pw-remove-book-icon" title="移除"></i>' : '';

        const $el = $(`
        <div class="pw-wi-book">
            <div class="pw-wi-header" style="display:flex; align-items:center;">
                <input type="checkbox" class="pw-wi-header-checkbox pw-wi-select-all" title="全选/全不选 (仅选中当前可见条目)">
                <span class="pw-wi-book-title">
                    ${book} ${statusLabel}
                </span>
                <div class="pw-wi-header-actions">
                    <div class="pw-wi-filter-toggle" title="展开/收起筛选"><i class="fa-solid fa-filter"></i></div>
                    ${pinIcon}
                    ${removeIcon}
                    <i class="fa-solid fa-chevron-down arrow"></i>
                </div>
            </div>
            <div class="pw-wi-list" data-book="${book}"></div>
        </div>`);
        
        $el.find('.pw-wi-select-all').on('click', async function(e) {
            e.stopPropagation();
            $(this).removeClass('pw-indeterminate').prop('indeterminate', false);
            const checked = $(this).prop('checked');
            const $list = $el.find('.pw-wi-list');
            
            const doCheck = () => {
                $list.find('.pw-wi-item:visible .pw-wi-check').prop('checked', checked);
                const checkedUids = [];
                $list.find('.pw-wi-check:checked').each(function() { checkedUids.push($(this).val()); });
                saveWiSelection(book, checkedUids);
            };

            if (!$list.is(':visible') && !$list.data('loaded')) {
                $el.find('.pw-wi-header').click(); 
                setTimeout(doCheck, 150);
            } else {
                doCheck();
            }
        });

        $el.find('.pw-pin-book-icon').on('click', function(e) {
            e.stopPropagation();
            if (store.pinnedBooks.includes(book)) {
                store.pinnedBooks = store.pinnedBooks.filter(b => b !== book);
                toastr.info(TEXT.TOAST_UNPINNED(book));
            } else {
                store.pinnedBooks.push(book);
                toastr.success(TEXT.TOAST_PINNED(book));
            }
            savePinnedBooks();
            renderWiBooks();
        });

        $el.find('.remove-book').on('click', (e) => {
            e.stopPropagation();
            store.extraBooks = store.extraBooks.filter(b => b !== book);
            store.pinnedBooks = store.pinnedBooks.filter(b => b !== book);
            savePinnedBooks();
            renderWiBooks();
        });
        
        $el.find('.pw-wi-filter-toggle').on('click', function(e) {
            e.stopPropagation();
            const $list = $el.find('.pw-wi-list');
            if (!$list.is(':visible')) {
                $el.find('.pw-wi-header').click();
            }
            setTimeout(() => {
                const $tools = $list.find('.pw-wi-depth-tools');
                if($tools.length) {
                    $tools.slideToggle();
                }
            }, 50);
        });

        $el.find('.pw-wi-header').on('click', async function (e) {
            if ($(e.target).hasClass('pw-wi-header-checkbox') || $(e.target).closest('.pw-wi-filter-toggle').length || $(e.target).closest('.pw-remove-book-icon').length) return; 

            const $list = $el.find('.pw-wi-list');
            const $arrow = $(this).find('.arrow');
            
            if ($list.is(':visible')) { 
                $list.slideUp(); 
                $arrow.removeClass('fa-flip-vertical'); 
            } else {
                $list.slideDown(); 
                $arrow.addClass('fa-flip-vertical');
                
                if (!$list.data('loaded')) {
                    $list.html('<div style="padding:10px;text-align:center;"><i class="fas fa-spinner fa-spin"></i></div>');
                    
                    const entries = await getWorldBookEntries(book);
                    $list.empty();
                    
                    if (entries.length === 0) {
                        $list.html('<div style="padding:10px;opacity:0.5;">无条目</div>');
                    } else {
                        const $tools = $(`
                        <div class="pw-wi-depth-tools">
                            <div class="pw-wi-filter-row">
                                <input type="text" class="pw-keyword-input" id="keyword" placeholder="关键词查找...">
                            </div>
                            <div class="pw-wi-filter-row">
                                <select id="p-select" class="pw-pos-select">
                                    <option value="unknown">全部位置</option>
                                    <option value="0">角色前</option>
                                    <option value="1">角色后</option>
                                    <option value="2">AN前</option>
                                    <option value="3">AN后</option>
                                    <option value="4">@深度</option>
                                    <option value="5">样例前</option>
                                    <option value="6">样例后</option>
                                </select>
                                <input type="number" class="pw-depth-input" id="d-min" placeholder="0" title="最小深度">
                                <span>-</span>
                                <input type="number" class="pw-depth-input" id="d-max" placeholder="Max" title="最大深度">
                            </div>
                            <div class="pw-wi-filter-row">
                                <button class="pw-depth-btn" id="d-filter-toggle" title="启用/取消筛选">筛选</button>
                                <button class="pw-depth-btn" id="d-clear-search">清空内容</button>
                                <button class="pw-depth-btn" id="d-reset" title="恢复为世界书原始状态">重置状态</button>
                            </div>
                        </div>`);
                        
                        let isFiltering = false;

                        const applyFilter = () => {
                            if (!isFiltering) {
                                $list.find('.pw-wi-item').show();
                                $tools.find('#d-filter-toggle').removeClass('active').text('筛选');
                                return;
                            }
                            $tools.find('#d-filter-toggle').addClass('active').text('取消筛选');
                            const keyword = $tools.find('#keyword').val().toLowerCase();
                            const pVal = $tools.find('#p-select').val();
                            const dMin = parseInt($tools.find('#d-min').val()) || 0;
                            const dMaxStr = $tools.find('#d-max').val();
                            const dMax = dMaxStr === "" ? 99999 : parseInt(dMaxStr);

                            $list.find('.pw-wi-item').each(function() {
                                const $row = $(this);
                                const d = $row.data('depth');
                                const code = $row.data('code'); 
                                const content = decodeURIComponent($row.find('.pw-wi-check').data('content')).toLowerCase();
                                const title = $row.find('.pw-wi-title-text').text().toLowerCase();
                                let matches = true;
                                if (keyword && !title.includes(keyword) && !content.includes(keyword)) matches = false;
                                if (matches && pVal !== 'unknown' && String(code) !== pVal) matches = false;
                                if (matches && (d < dMin || d > dMax)) matches = false;
                                if (matches) $row.show(); else $row.hide();
                            });
                        };

                        $tools.find('#d-filter-toggle').on('click', function() {
                            isFiltering = !isFiltering;
                            applyFilter();
                        });

                        $tools.find('#keyword').on('keyup', function(e) {
                            if (e.key === 'Enter') {
                                isFiltering = true;
                                applyFilter();
                            }
                        });

                        $tools.find('#d-clear-search').on('click', function() {
                            $tools.find('#keyword').val('');
                            if(isFiltering) applyFilter();
                        });

                        $tools.find('#d-reset').on('click', function() {
                             $list.find('.pw-wi-item').each(function() {
                                 const originalEnabled = $(this).data('original-enabled');
                                 $(this).find('.pw-wi-check').prop('checked', originalEnabled).trigger('change');
                             });
                             toastr.info(TEXT.TOAST_RESET_TO_WI);
                        });

                        $list.append($tools);

                        const savedSelection = loadWiSelection(book);

                        entries.forEach(entry => {
                            let isChecked = false;
                            if (savedSelection) {
                                isChecked = savedSelection.includes(String(entry.uid));
                            } else {
                                isChecked = entry.enabled;
                            }
                            
                            const checkedAttr = isChecked ? 'checked' : '';
                            const posAbbr = getPosAbbr(entry.position);
                            const infoLabel = `<span class="pw-wi-info-badge" title="位置:深度">[${posAbbr}:${entry.depth}]</span>`;

                            const $item = $(`
                            <div class="pw-wi-item" data-depth="${entry.depth}" data-code="${entry.position}" data-original-enabled="${entry.enabled}">
                                <div class="pw-wi-item-row">
                                    <input type="checkbox" class="pw-wi-check" value="${entry.uid}" ${checkedAttr} data-content="${encodeURIComponent(entry.content)}">
                                    <div class="pw-wi-title-text">
                                        ${infoLabel} ${entry.displayName}
                                    </div>
                                    <i class="fa-solid fa-eye pw-wi-toggle-icon"></i>
                                </div>
                                <div class="pw-wi-desc">
                                    ${entry.content}
                                    <div class="pw-wi-close-bar"><i class="fa-solid fa-angle-up"></i> 收起</div>
                                </div>
                            </div>`);
                            
                            $item.find('.pw-wi-check').on('change', function() {
                                const checkedUids = [];
                                $list.find('.pw-wi-check:checked').each(function() { checkedUids.push($(this).val()); });
                                saveWiSelection(book, checkedUids);
                                updateWiHeaderCheckbox($el);
                            });

                            $item.find('.pw-wi-toggle-icon').on('click', function (e) {
                                e.stopPropagation();
                                const $desc = $(this).closest('.pw-wi-item').find('.pw-wi-desc');
                                if ($desc.is(':visible')) { $desc.slideUp(); $(this).removeClass('active'); } else { $desc.slideDown(); $(this).addClass('active'); }
                            });
                            
                            $item.find('.pw-wi-close-bar').on('click', function () { 
                                const $desc = $(this).parent();
                                $desc.stop(true, true).slideUp(); 
                                $item.find('.pw-wi-toggle-icon').removeClass('active'); 
                            });
                            
                            $list.append($item);
                        });
                    }
                    $list.data('loaded', true);
                    updateWiHeaderCheckbox($el);
                }
            }
        });

        // Set initial indeterminate state: entries exist but list not yet expanded
        const initSel = loadWiSelection(book);
        const $cb = $el.find('.pw-wi-select-all');
        if (initSel === null || (initSel.length > 0)) {
            $cb.prop('indeterminate', true).addClass('pw-indeterminate');
        }

        container.append($el);
    }
};

function updateWiHeaderCheckbox($bookEl) {
    const $checks = $bookEl.find('.pw-wi-check');
    if ($checks.length === 0) return;
    const total = $checks.length;
    const checked = $checks.filter(':checked').length;
    const $header = $bookEl.find('.pw-wi-select-all');
    if (checked === 0) {
        $header.prop('checked', false).prop('indeterminate', false).removeClass('pw-indeterminate');
    } else if (checked === total) {
        $header.prop('checked', true).prop('indeterminate', false).removeClass('pw-indeterminate');
    } else {
        $header.prop('checked', false).prop('indeterminate', true).addClass('pw-indeterminate');
    }
}
