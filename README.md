# TT Toolkit（TT 工具箱）

TauriTavern 第三方扩展：为沉浸式角色扮演提供一套开箱即用的创作辅助工具——行动选项生成、条目池抽取注入、统一 API 端点管理、人设编织、消息楼层导航与剧情走向指引。

- 版本：v1.5.6
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
| 选项生成 | 独立旁路请求生成行动选项（不走宿主生成通道，密钥经宿主后端转发）：端点在「API」页选择，生成参数（每轮自动生成、按分类轮询、条数 1-10、上下文轮数、字数上下限、点击后填入/追加/直接发送）；条目池随机抽取注入（110 条内置条目·17 分类）。附「走向指引」卡：写一两句话告诉 AI 这轮剧情往哪走，可存为预设复用，留空则不注入 |
| 条目池 | 已并入「选项生成」页（抽取行为随生成参数配置）；条目内容随插件更新发布，无独立页面 |
| API | 统一端点管理：所有功能（选项生成、人设编织）共用一张端点表；端点「使用」即选为生成端点，任务参数（温度 1.0/流式/思考强度/超时）已固化为内置最优档，无需配置 |
| 导航 | 楼层导航：`/ttnav-top`、`/ttnav-prev`、`/ttnav-next`、`/ttnav-auto` 四条斜杠命令＋快速回复「工具箱」按钮；可在角色回复之间上/下跳转或回到顶部，也可开启自动置顶 |
| 人设 | 人设编织：以「请求 → 整理（curator）→ 生成」两段链从你的输入织出人设文本与世界书选择，钉选的世界书随用随带；生成中再点同一按钮可停止 |
| 日志 | 生成运行记录：选项生成与人设编织的每次请求/响应全文（成功、失败、取消全量，仅本会话）——列表、展开查看、一键复制；摘要行同步落宿主日志文件（`tauritavern.log`）供跨重启排障。模型输出不合 JSON 约定时选项生成会明确报错并带出原始输出，不再合成残缺选项 |

提示词组装是人设、角色卡、世界书、场景、走向、外部注入等分段的统一管线（`__TTK_PROMPTS__` 全局口可 dump 观测）；外部注入全自动：宿主侧其他扩展写入 extension prompts 的内容按深度排序自动并入，无需手工搬运。

## 数据说明

- **历史端点自动收编**：启动时自动把历史域形状的 API 端点（choice v1 域内端点、persona 旧快照端点字段）收编进统一端点表并提升全局活动端点键，幂等设计，可安全重复升级。
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
