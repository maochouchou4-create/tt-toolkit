# TT Toolkit（TT 工具箱）

TauriTavern 第三方扩展：为沉浸式角色扮演提供一套开箱即用的创作辅助工具——行动选项生成、条目池抽取注入、统一 API 端点管理、人设编织、消息楼层导航与剧情走向指引。

- 版本：v1.0.0
- 主页：<https://github.com/maochouchou4-create/tt-toolkit>

## 安装与更新

**安装**：把本仓 clone 进 TT 的第三方扩展目录（用户数据下 `extensions/`），重启或刷新 TT 后在扩展面板启用「TT Toolkit」：

```bash
cd <你的 TT 用户数据目录>/extensions/third-party
git clone https://github.com/maochouchou4-create/tt-toolkit
```

仓库自带构建产物（`dist/`），clone 即用，无需本地构建。

**更新**：TT 扩展面板的「检查更新」即 `git pull`——拉取后刷新页面即可用上新版本。

## 功能一览

扩展入口在 TT 界面的扩展菜单（魔棒面板）里，打开后是一个可拖动、可收起的多 tab 工具箱：

| Tab | 功能 |
| --- | --- |
| 选项生成 | 独立旁路请求生成行动选项（不走宿主生成通道，密钥经宿主后端转发）：生成通道（端点选择、输出契约 JSON 对象/结构化 schema/纯提示词、思考强度、流式、temperature/max_tokens）、生成参数（条数 1-10、上下文轮数、字数上下限、点击后填入/追加/直接发送）、每轮自动生成开关。附「走向指引」卡：写一两句话告诉 AI 这轮剧情往哪走，可存为预设复用，留空则不注入 |
| 条目池 | 内置 110 条默认条目（17 个分类）供随机抽取注入提示词；支持自建条目与多套池配置绑定聊天、旧版数据一键导入、池数据 JSON 备份导出/导入 |
| API | 统一端点管理：所有功能（选项生成、人设编织）共用一张端点表，支持流式/非流式、思维深度（thinking effort）、超时等任务级参数 |
| 导航 | 楼层导航：`/ttnav-top`、`/ttnav-prev`、`/ttnav-next`、`/ttnav-auto` 四条斜杠命令＋快速回复「工具箱」按钮；可在角色回复之间上/下跳转或回到顶部，也可开启自动置顶 |
| 人设 | 人设编织：以「请求 → 整理（curator）→ 生成」两段链从你的输入织出人设文本与世界书选择，钉选的世界书随用随带 |

提示词组装是人设、角色卡、世界书、场景、走向、外部注入等分段的统一管线（`__TTK_PROMPTS__` 全局口可 dump 观测）；外部注入全自动：宿主侧其他扩展写入 extension prompts 的内容按深度排序自动并入，无需手工搬运。

## 数据说明

- **旧版 choice 数据一键导入**：检测到旧版扩展的 `extension_settings.choice` 数据时，条目池 tab 会出现导入入口；池条目、池配置、API 端点（含激活端点）一键搬入，按 id 幂等去重，重复导入零新增，已忽略字段有报告清单。
- **人设幂等增量迁移**：旧版 persona 扩展的 localStorage 数据在首次启动时自动搬入新存储域，增量同步、可安全重复升级。
- **v1.0.0 起首启清理遗留 localStorage 键**：迁移完成后，七个旧遗留键（persona 5 个＋导航 2 个）会在启动管线末位被一次性删除并打上完成标记，此后不再触碰；已迁移进 settings 的数据不受影响。
- 所有新数据统一存放在 `extension_settings.ttToolkit`（全局域）与 `chat_metadata.ttToolkit`（聊天域），随 TT 自身的 settings 持久化，不另立存储。

## 回滚

本仓 v1.0.0 是全面重写版（`rewrite` 分支）。若需回到旧版实现，在扩展安装目录执行：

```bash
git checkout pre-rewrite
```

然后刷新 TT 页面即可。旧版的 choice 池与设置数据（存于 settings.json）未删、随旧版可用；persona 旧 localStorage 数据若已被 v1.0.0 首启清理，回滚后旧版人设模块会以空态启动——升回 v1.0.0 即从新存储域恢复全部数据。

## 开发

工具链：Node.js＋pnpm；构建 Vite（单入口 `src/main.ts` → `dist/index.js` ＋ `dist/index.css`），类型 Vue＋TS，规范 ESLint。

提交前七道质量门（全部通过再合入）：

```bash
pnpm typecheck                        # vue-tsc --noEmit
pnpm lint                             # eslint .
pnpm build                            # vite build
node --check dist/index.js            # 产物语法可解析
pnpm check-imports                    # @sillytavern/* 导入只许出现在 src/host/ 等架构纪律
pnpm check:host                       # host 适配层锚点与宿主源码对账
pnpm smoke                            # node 驱动 dist 的全链路冒烟（含二次启动 no-op）
```

**dev-harness**（无宿主浏览器调试环境）：构建产物＋宿主桩，起本地静态服务模拟 TT 宿主窗口：

```bash
pnpm build
pnpm harness                          # 生成 scripts/dev-harness/app.js
node scripts/dev-harness/serve.mjs    # http://127.0.0.1:4173/scripts/dev-harness/
```

浏览器打开上述地址即可操作完整扩展 UI（主题切换、数据重置按钮在顶栏），详见 `scripts/dev-harness/README.md`。

### 目录结构

```
├── manifest.json          # TT 扩展清单（指向 dist 产物）
├── dist/                  # 构建产物（index.js / index.css），随仓发布
├── src/
│   ├── main.ts            # 入口：浏览器宿主流 / node 冒烟流
│   ├── host/              # 宿主适配层——@sillytavern/* 导入的唯一合法区
│   ├── modules/           # 业务模块：choice（选项/池）、apis（统一端点）、persona、nav
│   ├── prompts/           # 提示词引擎：多任务模板、组装、外部注入
│   ├── shell/             # 工具箱壳：Vue 挂载、tab 框架、五个设置页
│   └── storage/           # 统一持久化服务＋迁移与遗留键清理
└── scripts/               # 质量门脚本与 dev-harness
```

关键约束：业务代码一律通过 `src/storage` 服务读写持久化、通过 `src/host` 适配层访问宿主 API——`@sillytavern/*` 裸导入只允许出现在 `src/host/`（由 `pnpm check-imports` 机器把关）。
