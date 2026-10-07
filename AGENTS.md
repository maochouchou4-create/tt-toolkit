# AGENTS.md — TT Toolkit 开发说明

任何 AI 编码工具（或新会话）接手本仓库前，先读完本文。

## 这是什么

TauriTavern（SillyTavern 的 Tauri 分支）的自维护扩展「TT 工具箱」：选项生成／条目池／提示词引擎／多端点 API／快速回复导航／人设管理。Vue 3 + TS + Pinia，Vite 构建，产物为单文件 `dist/index.js` + `dist/index.css`（manifest.json 只引用这两个，根目录再无其他入口）。

## 硬规矩（违反＝返工）

1. `src/host/` 是**唯一**允许 import `@sillytavern/*` 的区域（ambient d.ts + `scripts/check-host-anchors.mjs` 锚点机判；HOST_SRC_ROOT 指向本机 TauriTavern 源码树）。
2. host 适配层调用宿主对象方法须保留接收者（`getPresetManager` 返回 class 实例、方法体走 this；解引用后裸调丢 this——unbound-method 门禁把关）。
3. AFPL 纪律：参考旧 fork 源码只许借鉴概念，禁止照抄表达式。
4. 版本链三处一致：`src/version.ts` 字面量常量 + `manifest.json` + `package.json`。改任何 `src/` 代码必须走完「七门全绿 → 重建 dist → `node scripts/dev-harness/build.mjs`」才能 commit。
5. 条目池唯一真相源＝`src/modules/choice/pool/default-pool.json`。改池＝改 JSON + bump version + 重建，绝不经 TT 设置面写池。

## 七道门禁（commit 前全绿）

```
npx vue-tsc --noEmit
npx eslint .
pnpm build
node --check dist/index.js
node scripts/check-imports.mjs
node scripts/check-host-anchors.mjs
node scripts/smoke.mjs
```

smoke 有精确计数纪律（`CHOICE_PASS_EXPECTED` 等期望值）：新增用例必须同步 bump 期望数，禁止注释跳过或放宽断言来「变绿」。

## dev-harness（无 TT 宿主时的本机 DOM 验证）

- dist 重建后**必须**重跑 `node scripts/dev-harness/build.mjs`（app.js 是实体文件不是映射，忘了跑＝验证的是旧代码）。
- `node scripts/dev-harness/serve.mjs` → http://127.0.0.1:4173/scripts/dev-harness/
- 开壳正解：`document.getElementById('tt-toolkit-wand-entry').click()`。
- 陷阱：`.extensionsMenuExtensionButton` 是条目内图标 div（无文本），按它找按钮永远 undefined；`display:none` 的壳里 `querySelectorAll` 照样列出隐藏 tab（假阳性），以 `innerText` 判可见性。
- harness 存储在内存，刷新即丢端点等数据（正常现象，不是 bug）。

## 存储域纪律

写任何持久化数据前先定域（三域归属判据）：

- **跨聊天复用**（生成参数、端点表、条目池、提示词配置……）＝全局域 `extension_settings.ttToolkit`；
- **跟单次聊天走**（剧情走向……）＝聊天域 `chat_metadata.ttToolkit`；
- **单条消息的派生数据**（该楼选项……）＝该消息 `extra.ttToolkit`——写入必须是纯数据（宿主 swipe 会 structuredClone 进新槽位）；写前做对象校验（删楼会使索引左移）、写后立即 `saveCurrentChat()`；**生成开始须主动清旧档**（宿主 `clearMessageData` 白名单不碰 `ttToolkit`，普通 regenerate 不调，宿主不会替扩展清理）；
- 角色域 `character.data.extensions.ttToolkit` 预留，无写面。

新键义务：域键常量在**归属模块**定义（字面量仅此一份），并登记进 `src/storage/service.ts` 的 `GlobalDomain`/`ChatDomain` 显式键 union——漏登记 vue-tsc 即报错（编译期登记门）；排障走 `src/storage/debug.ts` 的 `dumpStorage()`。

旧扩展自身域（`extension_settings.choice` 等）只读迁移，迁移完成后不回写。localStorage 旧键已由 `src/storage/legacy-wipe.ts` 在 v1.0.0 首启一次性清理（persona 5 键 + nav 2 键），勿再引用。

## 提交与发布

- 提交信息中文、写清动机与范围；main 直做（用户拍板）：不建功能分支，施工直接在 main 提交、一批一笔、批末打 tag，push 即发布；push 后用户在 TT 面板「检查更新」拉取（匿名 HTTPS）。
- 回滚锚：tag `pre-rewrite`（旧三模块架构 v1.3.0）、tag `v1.0.0`。

## 深度背景（本机路径，仅限本机开发者）

- 重写方案已随 v1.0.0 收官按生命周期删除，不再有方案 SSOT 文件；跨会话进度与踩坑以下一条的 memory 条目为准。
- 跨会话进度与踩坑记忆：`C:\Users\34139\.dsh\memory\workspaces\D-code\tauritavern-toolkit.md`。写它前先读其文件头「维护规则」：两职（速览/当前状态/本机环境坑）；历史进 git log、规则进本文，里程碑只更新其「当前状态」节。
- 用户协作习惯：中文交流；咨询只答不动手，等明确「开工」才改码；施工者（子智能体）自述不作裁决证据，验收由 Lead 亲跑门禁＋亲读关键代码；用户无法打开 devtools（打包版 Tauri），验收指引只给 UI 级步骤。
