# dev-harness（宿主 stub 调试台）

不依赖真实酒馆环境、浏览器直接打开 tt-toolkit 产物做布局/交互自查的长期调试设施。

## 用法

```powershell
pnpm run build          # 先重建 dist（改 src 后每次都要跑）
pnpm run harness        # 生成 scripts/dev-harness/app.js（dist 重写产物）
# 然后浏览器直接打开（file:// 即可，无服务端）：
#   D:\code\repos\tt-toolkit\scripts\dev-harness\index.html
```

顶栏按钮：**切换主题**（SmartTheme 明暗两套变量模拟）、**重置数据**（清 localStorage 并刷新）。
壳入口＝输入区上方的魔棒菜单（#extensionsMenu 常开）里 tt-toolkit 条目，点开抽屉壳。

## 构成

| 文件 | 作用 |
| --- | --- |
| `index.html` | 宿主 DOM 骨架（顶栏/#chat/#send_form/#extensionsMenu/#movingDivs）＋加载顺序锚 |
| `harness.css` | 宿主骨架与皮肤模拟：SmartTheme 变量双主题、.drawer-content/.mes 等 |
| `stubs.js` | 宿主 stub：`window.__TT_HARNESS__` 各键（与 dist 的全部外部 import 一一对应，**每键都是命名空间对象**——键内再按导出名解构）＋窗口级全局（`window.$`/`SillyTavern.getContext`/`quickReplyApi`/`toastr`/`STBaiBaiBook`）＋假聊天数据 |
| `app.js` | **生成物**（build.mjs 产出，勿手改） |
| `build.mjs` | 把 `dist/index.js` 的外部 import 重写为 `const {...} = globalThis.__TT_HARNESS__.<key>` 解构（经典脚本形态，绕开 file:// 下 ESM 相对路径的 CORS 限制） |
| `serve.mjs` | 仓根静态 HTTP 服务（默认 4173，路径穿越守门）——自动化浏览器（Playwright 等）需走 HTTP，file:// 会被封 |
| `screenshots/` | 布局自查基线截图（明/暗/窄视口三轮，见下） |

## stub 覆盖面（消费契约）

stubs.js 只实现 tt-toolkit 实际消费的最小面；新增宿主依赖时 dist 的 import 语句会变，
build.mjs 按 STUBS 表 fail fast——先在 stubs.js 补对应键，再更新 build.mjs 的 STUBS 表。

- `events.js`：`event_types`（APP_READY/CHAT_CHANGED/MESSAGE_UPDATED/CHARACTER_MESSAGE_RENDERED/SETTINGS_LOADED）、`eventSource`（on/once/makeLast/makeFirst/removeListener/emit/emitAndWait）
- `script.js`：`saveSettingsDebounced`（内存日志）、`chat_metadata`、`characters`、`this_chid`、`getRequestHeaders`、`substituteParams`（{{user}}/{{char}} 等替换）、`sendTextareaMessage`（真把消息追加进假聊天）
- `extensions.js`：`extension_settings`（内存对象，storage 层 mutate 后落"盘"）
- `st-context.js`：`getContext()`（chat/chatId/characterId/executeSlashCommandsWithOptions/saveMetadata/powerUserSettings/extensionPrompts——含一个假记忆摘要槽位）
- `SlashCommand.js` / `SlashCommandParser.js`：斜令注册（注册名打 console）
- `RossAscends-mods.js`：`dragElement`（**真拖拽**：把手拖动壳并把位置写入 movingUIState，验证拖动与自恢复链路）
- `power-user.js`：`power_user`（persona_description/movingUI/movingUIState）
- `world-info.js`：`getWorldInfoPrompt`（固定桶返回）
- 窗口全局：`window.$`（最小选择器→数组包装）、`SillyTavern.getContext`、`quickReplyApi`（内存 QR 集，含 deleteQuickReply）、`toastr`（console）、`STBaiBaiBook`（getInjectedHistory 固定摘要）

全部内存态：刷新即重置。ttlog 的 Tauri invoke ABI 在 harness 内缺席，自动熔断降级（只影响持久日志，不影响功能）。

## 已知环境差异（harness ≠ 真宿主）

- FontAwesome 字体缺席：图标按类名补 Unicode 字符（`harness.css` 的 `.fa-toolbox::before` 等）
- 魔棒菜单常开（真宿主默认收起，hover 唤出）
- 楼层无虚拟化（真宿主是感知虚拟列表，nav 兜底滚动路径的差异不在 harness 验证范围）
- ttlog 的 Tauri invoke ABI 缺席（自动熔断降级）——host 探测清单里唯一预期「缺席」项
- `harness.css` 带 `* { box-sizing: border-box }`：对齐真宿主全局基线（TauriTavern `src/style.css:144`）。缺了它 .tt-shell 的 `width: min(560px, 100vw - 24px)` 会按内容盒计算，窄视口下外盒越界 1px——是仿真误差不是产品 bug
- `#floatingPrompt`：stubs 挂了个空壳（display:none）——它是 tt-toolkit 壳浮层/探针引用的宿主 drawer-content 浮层先例 DOM，harness 里补上才能让 host 探测清单全绿；tt-toolkit 不依赖其内容

## 布局自查基线（screenshots/）

文字基线（当前五 tab：选项生成／API／导航／人设／日志）：壳为抽屉浮层（复用宿主 .drawer-content 皮肤），明暗两主题（SmartTheme 变量）、窄视口不越界（`.tt-shell` 宽 `min(560px, 100vw - 24px)`）。历史一轮 Playwright 程序化审计（getBoundingClientRect 全子树越界＋文本溢出，`.tt-tab-host` 滚动可达豁免）：宽视口 1038×666 明暗两主题、窄视口 420×700 暗主题全零问题；壳拖拽（dragElement→movingUIState 写入）实测通过。留存截图：`harness-01` 底页（明）、`harness-02` 壳+选项条（明）、`harness-04` 壳（暗）、`harness-05` 窄视口（暗）——早于当前五 tab 形态，重拍时整体替换。
