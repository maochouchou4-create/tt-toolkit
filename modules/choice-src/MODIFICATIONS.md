# choice 源码化分叉（硬分叉）

## 出处与锚定

- 上游仓库：https://github.com/Junwu-Git/choice
- 锚定 commit：`a4d7b3766cd3347268d65db4e1e43a9d3f63c64d`（上游 main HEAD，浅克隆后已删除上游 `.git`，不跟上游同步）
- 上游许可证：**AFPL v9**（见本目录 `LICENSE`）。义务链照做：保留许可文本与本修改声明、源码随仓分发、**非商用**。
- 引入批次：tt-toolkit 批1（choice 源码化，行为保持重构）。

## 修改清单（相对锚定 commit）

1. **三挂载点容器参数化**（行为保持：默认值＝上游现值，零逻辑改动；批2 壳统一 UI 对接点）：
   - `src/index.ts`：浮球+设置面板挂载容器提取为模块常量 `FLOATING_ROOT_MOUNT`（默认 `document.body`）。
   - `src/core/panel-mount.ts`：聊天选项条挂载容器选择器提取为模块常量 `CHAT_PANEL_MOUNT_SELECTOR`（默认 `'#chat'`；初次挂载、reposition 兜底、parent 幂等检查三处共用）。
   - `src/core/wand-menu.ts`：魔棒菜单注入目标选择器提取为模块常量 `WAND_MENU_SELECTOR`（默认 `'#extensionsMenu'`；轮询查找与点击后收起两处共用）。
2. **构建部署位适配（行为保持：产物 import 形态与上游原产物一致）**：
   - `vite.config.ts`：`@sillytavern/*` 说明符的相对路径改为按扩展部署位定死 5 级上溯——上游按「仓库 clone 在酒馆 public 树内」截断推导，本 fork 在仓内独立构建无法沿用；production 构建关闭 source map。
   - `AGENTS.md`：同步布局与产物交付变化（头部段与构建验证段两处）。
3. 本文件（`MODIFICATIONS.md`）：AFPL v9 修改声明。

## 构建与产物

- 构建：本目录 `pnpm install && pnpm build`（Vite production 构建）。
- 产物：本目录 `dist/index.js`、`dist/index.css`（production 不生成 source map），复制到 tt-toolkit 根 `dist/`（文件名不变，manifest entry 不动）；本目录 `dist/` 系构建中间产物，根 `.gitignore` 排除、不入 git。
- i18n：本目录 `i18n/en.json` 与根 `i18n/en.json` 逐字一致（引入时核对）。
- CHANGELOG：上游条目止于 v1.5.0，v1.6.x/v1.7.0 系上游 CI 依赖 bump、无条目；fork 自维护 changelog 以锚定 commit 为起点。
