# TT Toolkit

TauriTavern 三合一扩展：persona（人设生成与润色）、choice（选项）、nav（消息回顶/导航）。单一 GitHub 更新链（auto_update）。

## 模块清单

| 模块 | 状态 | 说明 |
|---|---|---|
| `modules/persona/` | 已入 | 人设生成与润色，平移自 st-persona-weaver（原 personality v3.5.0），逻辑 0 改动、仅逃逸 import 深度 +2 |
| `dist/`（choice） | 已入 | 选项插件构建产物原样搬运（零改写，上游 v1.7.0），i18n 仅 `en` 键（禁 default，见方案教训） |
| `modules/nav/` | 已入 | 消息回顶/上下文导航，酒馆助手 v4 脚本移植（主窗口原生接线），输入区旁自注入按钮条 |

## 布局

```
tt-toolkit/
  manifest.json        # js:index.js / css:index.css / loading_order:120 / auto_update:true
  index.js             # loader：模块注册制，动态 import + 每模块独立 try/catch
  index.css            # @import 各模块 CSS（@import 置首）
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

- 根目录无构建步骤、无 npm 依赖；`package.json` 仅声明 `"type": "module"`。
- persona 的 lint / test 依赖 devDependencies，须先在 `modules\persona\` 内 `npm i`，再跑 `npm run lint` / `npm run test`（`check` / `gate-*` 同理，均在模块目录内执行）。
- persona 对宿主模块（extensions.js / script.js 等）的逃逸 import 按安装深度 `modules/persona/` 写死（src 下 6-8 级 `../`），仓内跑 `npm run check` 会按宿主白名单跳过这些说明符；tests 经 `tests/hooks.mjs` 桩掉宿主模块。
