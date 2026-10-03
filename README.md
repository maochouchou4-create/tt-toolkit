# TT Toolkit

TauriTavern 三合一扩展：persona（人设生成与润色）、choice（选项）、nav（消息回顶/导航）。单一 GitHub 更新链（auto_update）。

## 模块清单

| 模块 | 状态 | 说明 |
|---|---|---|
| `modules/persona/` | 已入 | 人设生成与润色，平移自 st-persona-weaver（原 personality v3.5.0），逻辑 0 改动、仅逃逸 import 深度 +2 |
| `dist/`（choice） | 已入 | 选项插件构建产物原样搬运（零改写，上游 v1.7.0），i18n 仅 `en` 键（禁 default，见方案教训） |
| `modules/nav/` | 已入 | 消息回顶/上下文导航，酒馆助手 v4 脚本移植（主窗口原生接线）；入口＝快速回复栏「tt-toolkit 导航」按钮集（四按钮：回顶/上一条/下一条/自动回顶开关），`/ttnav-top` `/ttnav-prev` `/ttnav-next` `/ttnav-auto` 命令可直接在输入框敲。按钮集首次运行自动创建并挂载；从栏上移除或整集删除后不自动挂回（整集删除时下次启动会重建集合条目、不占栏），需要时在快速回复设置中手动挂回 |

## 布局

```
tt-toolkit/
  manifest.json        # js:index.js / css:index.css / loading_order:120 / auto_update:true
  index.js             # loader：模块注册制，动态 import + 每模块独立 try/catch
  index.css            # @import 各模块 CSS（@import 置首）
  eslint.config.js     # 根 lint 门（no-undef 正确性门，监听 loader/nav/shared）
  shared/log.js        # createTtlog(target)：TT 官方日志管线转发器工厂
  prompts/             # 跨模块共享提示词资产位（现占位）
  dist/                # choice 构建产物（批2；放根部、非 modules/choice/dist）
  modules/
    persona/           # 含自带 dev kit（package.json/eslint.config.js/scripts/tests）
```

**dist/ 放根部的理由**：choice 构建产物内部以 5 级 `../` 回溯引用宿主模块，放根部使 URL 深度与上游安装布局完全一致＝零改写，上游同步＝直接覆盖 `dist/`，避免逐行深度手术。

## 加新模块（三步法）

1. 建 `modules/<id>/` 目录（或根部产物目录），放入模块文件；
2. `index.js` 的 `MODULES` 注册数组加一行 `{ id: "<id>", load: () => import(...) }`；
3. `index.css` 追加一行 `@import url("modules/<id>/style.css");`（有样式才加）。

loader 每模块独立 try/catch：单模块崩溃只 console.error + toastr，不影响其他模块。

## 开发者说明

- 根目录无构建步骤；`package.json` 仅声明 `"type": "module"` 与 devDependency `eslint`（根 lint 门＝`npm run lint` / `npx eslint .`，先在根目录 `npm i`）。门定位＝抓 no-undef 类 typo，监听面＝`index.js` + `modules/nav/**` + `shared/**`；persona 自带独立 lint 门（见下）。
- persona 的 lint / test 依赖 devDependencies，须先在 `modules\persona\` 内 `npm i`，再跑 `npm run lint` / `npm run test`（`check` / `gate-*` 同理，均在模块目录内执行）。
- persona 对宿主模块（extensions.js / script.js 等）的逃逸 import 按安装深度 `modules/persona/` 写死（src 下 6-8 级 `../`），仓内跑 `npm run check` 会按宿主白名单跳过这些说明符；tests 经 `tests/hooks.mjs` 桩掉宿主模块。
