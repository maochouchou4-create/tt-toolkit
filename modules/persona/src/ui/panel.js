// 面板 HTML 构建＋打开＋打开时初始化。模板字符串与初始化序列强耦合，整体搬移不内拆。
import { getContext } from "../../../../../../../extensions.js";
import { callPopup } from "../../../../../../../../script.js";
import { store, loadData, loadState, saveState } from "../state.js";
import { DEFAULT_PROMPTS, DEFAULT_TEMPLATES } from "../prompts.js";
import { defaultSettings } from "../api.js";
import { getPresetHintText } from "../generation.js";
import { loadAvailableWorldBooks } from "../world-info.js";
import { getCurrentCharacter, getUserDisplayName } from "../st-data.js";
import { TEXT } from "../strings.js";
import { warn as logWarn } from "../log.js";
import { escapeHtml } from "../html.js";
import { autoBindGreetings, renderApiProfiles, renderGreetingsList } from "./render.js";
import { renderWiBooks } from "./world-book-widget.js";

const PROMPT_VIEW_SECTIONS = [
    {
        title: "策展提示词（curator）",
        note: "点击「生成」后的第一段调用：AI 按世界书与角色卡决定本次人设的 YAML 结构（只出键不出值）。世界书不走占位符，作为独立 system 消息随请求注入。占位符：{{charInfo}}＝角色卡信息、{{userRequirements}}＝你的额外需求（空则省略）。",
        body: () => DEFAULT_PROMPTS.curator
    },
    {
        title: "生成提示词（personaGen）",
        note: "两段链第二段：按策展出的 schema 填充人设；refine（润色）复用同一段但不注入 schema。占位符：{{template}}＝策展 schema（refine 时整块移除）、{{input}}＝需求或润色意见、{{charInfo}}＝角色卡、{{greetings}}＝开场白、{{user}}＝用户名。",
        body: () => DEFAULT_PROMPTS.personaGen
    },
    {
        title: "默认模板（user）",
        note: "策展失败或零素材时的回退 schema（六块结构）。占位符：{{user}}＝用户名。",
        body: () => DEFAULT_TEMPLATES.user
    }
];

// 旧版独立 API 记录迁移为配置档（幂等）：无 apiProfiles 时把现值收成「默认配置 1」。
function migrateApiProfiles(savedState, localConfig) {
    if (localConfig.apiProfiles) return;
    localConfig.apiProfiles = [];
    const existingUrl = localConfig.indepApiUrl || defaultSettings.indepApiUrl;
    if (existingUrl) {
        localConfig.apiProfiles.push({
            id: Date.now().toString(),
            name: "默认配置 1",
            url: existingUrl,
            key: localConfig.indepApiKey || defaultSettings.indepApiKey || "",
            model: localConfig.indepApiModel || defaultSettings.indepApiModel || ""
        });
        localConfig.activeApiProfileId = localConfig.apiProfiles[0].id;
    }
    savedState.localConfig = localConfig;
    saveState(savedState);
}

// 预设下拉选项：默认两项＋宿主 openai 预设名单（本 fork 的 preset_names 是 {名字: 索引} 对象）。
function buildPresetOptions() {
    let presetOptionsHtml = `
        <option value="current" ${store.uiStateCache.generationPreset === 'current' ? 'selected' : ''}>跟随酒馆预设 (Default)</option>
        <option value="pure" ${store.uiStateCache.generationPreset === 'pure' ? 'selected' : ''}>✨ 纯净模式 (Pure Mode)</option>
    `;
    try {
        const rawNames = getContext().getPresetManager('openai').getPresetList().preset_names || {};
        const presets = (Array.isArray(rawNames) ? rawNames : Object.keys(rawNames)).slice().sort();
        presets.forEach(p => {
            const sel = store.uiStateCache.generationPreset === p ? 'selected' : '';
            presetOptionsHtml += `<option value="${p}" ${sel}>[预设] ${p}</option>`;
        });
    } catch (e) {
        // 宿主预设管理器未就绪时下拉框只显示默认两项，不阻断面板打开
        logWarn("预设列表加载失败:", e);
    }
    return presetOptionsHtml;
}

// 弹窗打开后的初始化序列：异步装载世界书、渲染三个动态区、恢复折叠态。
function initCreatorPanel() {
    loadAvailableWorldBooks().then(() => {
        renderWiBooks();
        const options = store.availableWorldBooks.length > 0 ? store.availableWorldBooks.map(b => `<option value="${b}">${b}</option>`).join('') : `<option disabled>未找到世界书</option>`;
        $('#pw-wi-select').html(`<option value="">-- 添加参考/目标世界书 --</option>${options}`);
    });

    renderGreetingsList();
    autoBindGreetings();
    renderApiProfiles();

    $('.pw-auto-height').each(function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });

    if (store.userContext.hasResult) {
        $('#pw-request').addClass('minimized');
    }
}

export async function openCreatorPopup() {
    const context = getContext();
    loadData();

    const savedState = loadState();
    let localConfig = savedState.localConfig || {};

    migrateApiProfiles(savedState, localConfig);

    const config = { ...defaultSettings, ...savedState.localConfig };

    const currentName = getUserDisplayName();

    const activeData = store.userContext;

    const charName = getCurrentCharacter()?.name || "None";

    const headerTitle = `${TEXT.PANEL_TITLE}<span class="pw-header-subtitle">User:${currentName} & Char:${charName}</span>`;

    const presetOptionsHtml = buildPresetOptions();

    const initialHint = getPresetHintText(store.uiStateCache.generationPreset);

    let initialProfileName = "默认配置 1";
    if (localConfig.apiProfiles && localConfig.apiProfiles.length > 0) {
        const activeProf = localConfig.apiProfiles.find(p => p.id === localConfig.activeApiProfileId);
        if (activeProf) initialProfileName = activeProf.name;
    } else if (localConfig.activeApiProfileId === 'custom') {
        initialProfileName = "";
    }

    const html = `
<div class="pw-wrapper">
    <div class="pw-header">
        <div class="pw-top-bar"><div class="pw-title">${headerTitle}</div></div>
        <div class="pw-tabs">
            <div class="pw-tab active" data-tab="editor">人设</div>
            <div class="pw-tab" data-tab="context">参考</div> 
            <div class="pw-tab" data-tab="api">API</div>
            <div class="pw-tab" data-tab="prompts">提示词</div>
        </div>
    </div>

    <!-- Editor View -->
    <div id="pw-view-editor" class="pw-view active">
        <div class="pw-scroll-area">
            <!-- Load Persona Entry -->
            <div class="pw-info-display">
                <div class="pw-load-btn" id="pw-btn-load-current">载入已有人设</div>
            </div>

            <textarea id="pw-request" class="pw-textarea pw-auto-height" placeholder="额外需求（可选）——想要什么样的角色、要加什么字段…">${activeData.request}</textarea>
            <button id="pw-btn-gen" class="pw-btn gen"><i class="fa-solid fa-wand-magic-sparkles"></i> 生成 User 设定</button>

            <div id="pw-result-area" style="display:${activeData.hasResult ? 'block' : 'none'}; margin-top:15px;">
                <div class="pw-relative-container">
                    <textarea id="pw-result-text" class="pw-result-textarea pw-auto-height" placeholder="生成的结果将显示在这里..." style="min-height: 200px;">${activeData.result}</textarea>
                </div>
                
                <div class="pw-refine-toolbar">
                    <textarea id="pw-refine-input" class="pw-refine-input" placeholder="输入意见，或选中上方文字后点击浮窗快速修改..."></textarea>
                    <div class="pw-refine-btn-vertical" id="pw-btn-refine" title="执行润色">
                        <span class="pw-refine-btn-text">润色</span>
                        <i class="fa-solid fa-magic"></i>
                    </div>
                </div>
            </div>
        </div>

        <div class="pw-footer">
            <div class="pw-footer-group">
                <div class="pw-compact-btn danger" id="pw-clear" title="清空"><i class="fa-solid fa-eraser"></i></div>
                <div class="pw-compact-btn" id="pw-copy-persona" title="复制内容"><i class="fa-solid fa-copy"></i></div>
            </div>
            <div class="pw-footer-group" style="flex:1; justify-content:flex-end; gap: 8px;">
                <button class="pw-btn wi" id="pw-btn-save-wi">保存至世界书</button>
                <button class="pw-btn save" id="pw-btn-apply">覆盖当前人设</button>
            </div>
        </div>
    </div>

    <!-- Diff Overlay -->
    <div id="pw-diff-overlay" class="pw-diff-container" style="display:none;">
        <div class="pw-diff-toolbar">
            <span id="pw-diff-hint" class="pw-diff-hint-inline"><i class="fa-solid fa-circle-info"></i> 点击高亮文字切换版本</span>
            <div style="flex:1;"></div>
            <button class="pw-diff-mode-btn" data-mode="old"><i class="fa-solid fa-file-lines"></i> 原版</button>
            <button class="pw-diff-mode-btn" data-mode="new"><i class="fa-solid fa-file-circle-plus"></i> 新版</button>
            <button class="pw-diff-mode-btn" data-mode="final"><i class="fa-solid fa-eye"></i> 最终</button>
        </div>
        
        <div class="pw-diff-content-area">
            <div id="pw-diff-merge-view" class="pw-diff-merge-view">
                <div id="pw-diff-merge-list" class="pw-diff-mode-all"></div>
            </div>
        </div>

        <div class="pw-diff-actions">
            <button class="pw-btn primary" id="pw-diff-reroll" title="使用相同的提示词重新生成"><i class="fa-solid fa-rotate-right"></i> 重新生成</button>
            <div style="flex:1;"></div>
            <button class="pw-btn danger" id="pw-diff-cancel"><i class="fa-solid fa-xmark"></i> 放弃</button>
            <button class="pw-btn gen" id="pw-diff-confirm" style="width:auto;"><i class="fa-solid fa-check"></i> 应用</button>
        </div>
    </div>

    <!-- Load Persona Overlay -->
    <div id="pw-load-overlay" class="pw-load-overlay-backdrop">
        <div class="pw-load-overlay-card">
            <div class="pw-load-overlay-header">
                <span id="pw-load-overlay-title">载入已有人设</span>
                <button class="pw-btn danger" id="pw-load-overlay-close" style="padding:4px 10px;"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div id="pw-load-overlay-content" class="pw-load-overlay-body"></div>
        </div>
    </div>

    <div id="pw-float-quote-btn" class="pw-float-quote-btn"><i class="fa-solid fa-pen-to-square"></i> 修改此段</div>

    <!-- Context View -->
    <div id="pw-view-context" class="pw-view">
        <div class="pw-scroll-area">
            
            <div class="pw-card-section">
                <div class="pw-row">
                    <label class="pw-section-label">生成预设</label>
                    <select id="pw-preset-select" class="pw-input" style="flex:1; width:100%;">
                        ${presetOptionsHtml}
                    </select>
                </div>
                <div id="pw-preset-hint" style="font-size:0.8em; opacity:0.7; margin-top:4px; margin-left: 5px; color: var(--SmartThemeBodyColor);">
                    ${initialHint}
                </div>
            </div>

            <div class="pw-card-section">
                <div class="pw-row">
                    <label class="pw-section-label pw-label-gold">角色开场白</label>
                    <select id="pw-greetings-select" class="pw-input" style="flex:1; width:100%;">
                        <option value="">(不使用开场白)</option>
                    </select>
                </div>
                <div id="pw-greetings-toggle-bar" class="pw-preview-toggle-bar" style="display:none;">
                    <i class="fa-solid fa-angle-up"></i> 收起预览
                </div>
                <textarea id="pw-greetings-preview" style="display:none; min-height: 300px; margin-top:5px;"></textarea>
            </div>

            <div class="pw-card-section">
                <div class="pw-row" style="margin-bottom:5px;">
                    <label class="pw-section-label pw-label-blue">世界书</label>
                </div>
                <div id="pw-wi-body" style="display:block; padding-top:5px;">
                    <div class="pw-wi-controls" style="margin-bottom:8px;">
                        <select id="pw-wi-select" class="pw-input pw-wi-select"><option value="">正在加载...</option></select>
                        <button id="pw-wi-add" class="pw-btn primary pw-wi-add-btn"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    <div id="pw-wi-container"></div>
                </div>
            </div>
        </div>
    </div>

    <!-- API View (Only Connection) -->
    <div id="pw-view-api" class="pw-view">
        <div class="pw-scroll-area">
            <div class="pw-card-section">
                <div class="pw-row"><label>API 来源</label><select id="pw-api-source" class="pw-input" style="flex:1;"><option value="main" ${config.apiSource === 'main' ? 'selected' : ''}>主 API</option><option value="independent" ${config.apiSource === 'independent' ? 'selected' : ''}>独立 API</option></select></div>
                <div id="pw-indep-settings" style="display:${config.apiSource === 'independent' ? 'flex' : 'none'}; flex-direction:column; gap:15px; margin-top:8px;">
                    
                    <!-- 选择预设 -->
                    <div class="pw-row" style="padding-bottom: 12px; border-bottom: 1px dashed var(--SmartThemeBorderColor);">
                        <label>配置预设</label>
                        <div style="flex:1; display:flex; gap:5px; width:100%; min-width: 0;">
                            <select id="pw-api-profile-select" class="pw-select" style="flex:1;"></select>
                            <button id="pw-api-profile-add" class="pw-btn primary" title="把当前表单保存为新配置" style="width:auto; padding: 6px 10px;"><i class="fa-solid fa-floppy-disk"></i></button>
                            <button id="pw-api-profile-delete" class="pw-btn danger" title="删除当前配置" style="width:auto; padding: 6px 10px;"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>

                    <!-- 配置编辑表单 -->
                    <div class="pw-row"><label>配置命名</label><input type="text" id="pw-api-profile-name" class="pw-input" value="${initialProfileName}" style="flex:1;" placeholder="例如: OpenAI, Claude..."></div>
                    <div class="pw-row"><label>URL</label><input type="text" id="pw-api-url" class="pw-input" value="${config.indepApiUrl}" style="flex:1;" placeholder="http://.../v1"></div>
                    <div class="pw-row"><label>Key</label><input type="password" id="pw-api-key" class="pw-input" value="${config.indepApiKey}" style="flex:1;"></div>
                    <div class="pw-row"><label>Model</label>
                        <div style="flex:1; display:flex; gap:5px; width:100%; min-width: 0;">
                            <select id="pw-api-model-select" class="pw-select" style="flex:1;"><option value="${config.indepApiModel}">${config.indepApiModel}</option></select>
                            <button id="pw-api-fetch" class="pw-btn primary pw-api-fetch-btn" title="刷新模型列表" style="width:auto;"><i class="fa-solid fa-sync"></i></button>
                            <button id="pw-api-test" class="pw-btn primary" style="width:auto;" title="测试连接"><i class="fa-solid fa-plug"></i></button>
                        </div>
                    </div>
                    <div class="pw-row">
                        <label title="单次请求最长等待时间。Claude / 第三方中转站输出长 YAML 常需 2~5 分钟，默认 300 秒。超时后会提示而不再静默失败。">请求超时 (秒)</label>
                        <input type="number" id="pw-indep-timeout" class="pw-input" min="30" max="1800" step="10"
                            value="${Number(config.indepTimeout) > 0 ? Number(config.indepTimeout) : 300}"
                            style="flex:1;" placeholder="300">
                    </div>
                </div>
                <!-- 两来源通用设置：位于 #pw-indep-settings 之外，主 API 选中时同样可见可改 -->
                <div class="pw-row" style="margin-top:12px;">
                    <label title="开启后以 SSE 流式方式接收响应，避免 Cloudflare / 酒馆后端 / 中转站在等待完整响应时返回 504 Gateway Timeout。此开关同时作用于独立 API 和主 API。">流式输出</label>
                    <div style="flex:1; display:flex; align-items:center; gap:8px;">
                        <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer;">
                            <input type="checkbox" id="pw-indep-stream" ${config.indepStream !== false ? 'checked' : ''}>
                            <span style="opacity:0.85;">启用 (推荐，避免 504)</span>
                        </label>
                    </div>
                </div>
                <div class="pw-row">
                    <label title="向模型请求的推理深度，越高越慢越贵。模型不识别该参数时会被忽略或报错，属预期。">思考强度</label>
                    <select id="pw-thinking-effort" class="pw-select" style="flex:1;">
                        <option value="off" ${config.thinkingEffort === 'off' ? 'selected' : ''}>关</option>
                        <option value="low" ${config.thinkingEffort === 'low' ? 'selected' : ''}>低</option>
                        <option value="medium" ${config.thinkingEffort === 'medium' ? 'selected' : ''}>中</option>
                        <option value="high" ${config.thinkingEffort === 'high' ? 'selected' : ''}>高</option>
                    </select>
                </div>
            </div>
        </div>
    </div>

    <!-- Prompts View（只读调优对照：显示当前生效内容，真源在 src/prompts.js，改动找 Agent） -->
    <div id="pw-view-prompts" class="pw-view">
        <div class="pw-scroll-area">
            <div class="pw-card-section">
                <div class="pw-prompt-note">只读显示当前生效的提示词与模板。真源在 src/prompts.js，调优找 Agent 改代码。</div>
            </div>
            ${PROMPT_VIEW_SECTIONS.map((s) => `
            <div class="pw-card-section">
                <div class="pw-row" style="flex-direction:column; align-items:flex-start; gap:4px;">
                    <label class="pw-section-label">${s.title}</label>
                    <div class="pw-prompt-note">${s.note}</div>
                </div>
                <pre class="pw-prompt-view">${escapeHtml(s.body())}</pre>
            </div>`).join("")}
        </div>
    </div>
</div>
`;

    callPopup(html, 'text', '', { wide: true, large: true, okButton: "Close" });

    initCreatorPanel();
}
