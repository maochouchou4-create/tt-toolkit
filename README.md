# TT Toolkit（TT 工具箱）

TauriTavern 第三方扩展：为沉浸式角色扮演提供一套开箱即用的创作辅助工具——行动选项生成、条目池抽取注入、统一 API 端点管理、人设编织、消息楼层导航与剧情走向指引。

- 主页：<https://github.com/maochouchou4-create/tt-toolkit>

## 安装与更新

**安装**：把本仓 clone 进 TT 的第三方扩展目录（用户数据下 `extensions/`），重启或刷新 TT 后在扩展面板启用「TT Toolkit」：

```bash
cd <你的 TT 用户数据目录>/extensions/third-party
git clone https://github.com/maochouchou4-create/tt-toolkit
```

仓库自带构建产物（`dist/`），clone 即用，无需本地构建。

验证基线为 **TauriTavern 2.3.0**（推荐）；扩展的最低兼容门按宿主所兼容的 SillyTavern 版本登记为 1.18.0，更老的宿主不会被激活（扩展面板里可能不显示工具箱）。

**更新**：TT 扩展面板的「检查更新」即 `git pull`——拉取后刷新页面即可用上新版本。

## 功能一览

扩展入口在 TT 界面的扩展菜单（魔棒面板）里，打开后是一个可拖动、可收起的多 tab 工具箱：

| Tab | 功能 |
| --- | --- |
| 选项生成 | 独立旁路请求生成行动选项（不走宿主生成通道，密钥经宿主后端转发），呈现为每条 AI 回复楼层正文末尾的选项块（两列卡片，随楼层滚动、可回看旧楼选项；点选即按设置填入/追加/直接发送）：生成入口是「tt-toolkit 导航」快速回复集的「生成」键（生成中再点＝取消），或输入框敲 `/tt-choice-gen`；端点在「API」页选择，生成参数（每轮自动生成、按分类轮询、条数 1-10、候选倍率、置顶超额策略、末段打乱、字数上下限、点击后填入/追加/直接发送）；条目池随机抽取注入（124 条内置条目·9 分类）。附「走向指引」卡：写一两句话告诉 AI 这轮剧情往哪走，可存为预设复用，留空则不注入。上下文与宿主主生成同构：全部可见楼层 |
| 条目池 | 已并入「选项生成」页（抽取行为随生成参数配置）；条目内容随插件更新发布，无独立页面 |
| API | 服务商与任务模型两层分离：所有功能共用一张服务商表（url+key＝接入身份，可拉取模型清单缓存（拉取后可勾选保留，清单即任务模型下拉的候选集））；「任务模型」卡按任务（选项生成/人设生成）独立选择服务商与模型，温度与思考强度按行可调（留空即推荐档），首行「批量设置」可把全部任务一键换用同一服务商与模型（各行温度与思考保持原值）。生成注入：破限预设可选——选中宿主预设的启用文本条目按原角色插到创作类任务每次请求最前（预设采样参数不生效） |
| 人设 | 人设编织：以「请求 → 整理（curator）→ 生成 → 模型复核查重」三段链从你的输入织出人设文本与世界书选择，钉选的世界书随用随带；生成中再点同一按钮可停止。结果框下方常驻一行复核简报（未发现重复／已改写哪些字段／没能跑完并保留上一版）；「覆盖当前人设」写回后描述框与人设列表即时刷新，无需刷新页面。预设影响统一走「API」页的破限预设（无任务级预设选择） |
| 日志 | 生成运行记录：选项生成与人设编织的每次请求/响应全文（成功、失败、取消全量，仅本会话）——列表、展开查看、一键复制；摘要行同步落宿主日志文件（`tauritavern.log`）供跨重启排障。模型输出未完整收尾（每条选项完整而缺容器闭合、或句中被截断）时，选项生成按元素级恢复出完整可用的选项并标「部分恢复」徽标；模型输出不合 JSON 约定时仍明确报错并带出原始输出，不再合成残缺选项；模型返回空白正文时明确指认真因（可能被上游拦截或思维链耗尽输出预算）并提示重试或更换端点 |

楼层导航不是 tab（无独立页面，恒开无需配置）：`/ttnav-top`、`/ttnav-prev`、`/ttnav-next` 三条斜杠命令＋快速回复「生成」「工具箱」按钮（「生成」即 `/tt-choice-gen`，生成中再点取消；`/ttnav-*` 可在角色回复之间上/下跳转或回到顶部，生成结束后自动回顶到最新楼层）。

提示词组装是人设、角色卡、世界书、场景、走向、外部注入等分段的统一管线（`__TTK_PROMPTS__` 全局口可 dump 观测）；外部注入全自动：宿主侧其他扩展写入 extension prompts 的内容按深度排序自动并入，无需手工搬运。

## 池子与提示词在哪看

工具箱不在界面里做池浏览页——内置条目与提示词的单一真相源就是仓库文件，想看想改直接翻这几个文件：

| 想看什么 | 文件 | 里头是什么 |
| --- | --- | --- |
| 选项池全部内置条目 | `src/modules/choice/pool/default-pool.json` | 124 条走法·9 分类；每条＝type（走法名，全池唯一）＋content（注入提示词的正文）＋category。「转场推进」是唯一置顶条目。文件顶部的 `version` 是池版本唯一来源，改条目就 bump 它——存量档启动时按它判断要不要整池重建 |
| 选项生成的规则与输出格式 | `src/prompts/default-texts.ts` | `CHOICE_CORE_RULES_TEXT`（九条写作规则，含直球位与新元素边界）、`CHOICE_OUTPUT_FORMAT_TEXT`（JSON 形状、标题必须点出核心动作、aim 忠实性）、`CHOICE_FEW_SHOT_TEXT`（四条输出示例） |
| 人设生成的模板正文 | 同文件 `src/prompts/default-texts.ts` | `PERSONA_CURATOR_PROMPT`（策展段）与 `PERSONA_GEN_PROMPT`（档案段）；档案目录定义在 `src/modules/persona/catalog.ts` |
| 默认生成参数 | `src/modules/choice/pool/normalize.ts` | `DEFAULT_POOL_GEN_PARAMS`：条数、候选倍率（默认 150，只对全新安装生效——老存档保留自己保存过的值，想调去「选项生成」页）等 |
| 模板/池的版本号 | `src/prompts/defaults.ts` | 模板即代码常量，随 dist 发布即刻生效，无存量迁移面（版本化重建机器已随 tt-slim 批 C 退役）；池版本号见条目池一行 |

改模板或池属于一次改版：bump 对应版本号、七道质量门全绿、重建 `dist/` 再提交（命令见「开发」节）；普通用户侧 `git pull` 后刷新 TT 即生效。

## 与其他记忆插件共存

记忆（前情摘要、人物关系、剧情状态）建议交给外部记忆插件——例如小白X 的「剧情总结」。它把总结写进 TT 的公共注入区后，工具箱会自动把这部分内容带进每一次选项生成，无需任何配置；总结过的老楼层也会由它折叠收纳，不会挤占上下文。

工具箱自身不带总结功能——不装任何记忆插件时，很长的聊天将没有前情记忆可用。如果你的宿主预设里还启用了记忆/摘要类的条目或正则，注意和记忆插件只开一层，避免同一段剧情被注入两遍。

## 数据说明

- **tt-slim 瘦身程序收官（v1.28.0）**：四批（发布件分块／历史机器退役／提示词域清残／单源与门禁小件）全部落地——分类名单、注入行数公式与倍率值域、构建产物一致性、版本链一致性均已收成单源＋机器门；除 ≤480px 窄壳回退样式删除外零使用面变化。
- **历史机器已退役（tt-slim 批 B）**：旧版数据的三步迁移（persona 域搬入、统一端点收编、任务档案化）与旧 localStorage 遗留键的一次性清理机器已整体删除。从 v1.9.x 及更早版本一路升级上来的存量档不受影响（数据早已迁完）；带着从未迁移过的远古存档直上新版时不再自动收编——端点需在「API」页手动重配，导航 QR 激活态会重走一次激活，旧 localStorage 键残留为无害孤儿。
- 所有新数据统一存放在 `extension_settings.ttToolkit`（全局域）与 `chat_metadata.ttToolkit`（聊天域），随 TT 自身的 settings 持久化，不另立存储。

## 回滚

本仓 v1.0.0 起是全面重写版。若需回到旧版实现，在扩展安装目录执行（回滚锚是 tag `pre-rewrite`，旧版即 tag 指向的提交）：

```bash
git checkout pre-rewrite
```

然后刷新 TT 页面即可。旧版的 choice 池与设置数据（存于 settings.json）未删、随旧版可用；persona 旧 localStorage 数据若已被 v1.0.0 首启清理，回滚后旧版人设模块会以空态启动——升回 v1.0.0 即从新存储域恢复全部数据。

## 开发

工具链：Node.js＋pnpm；构建 Vite（入口 `src/main.ts` → `dist/index.js` ＋ `dist/index.css`，node 冒烟面拆按需 chunk），类型 Vue＋TS，规范 ESLint。

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
pnpm harness                          # 生成 scripts/dev-harness/dist-harness/（产物模块）
node scripts/dev-harness/serve.mjs    # http://127.0.0.1:4173/scripts/dev-harness/
```

门序依赖：`pnpm harness` 不在七门清单里，但 smoke 尾部的产物漂移门（dist 现产物经转换与 `dist-harness/` 逐字比对）要求它在 smoke 之前对最新 dist 跑过——改 src 后按 `pnpm build` → `pnpm harness` → 其余各门（含 smoke）推进；提交前七门与 harness build 全绿。

浏览器打开上述地址即可操作完整扩展 UI（主题切换、数据重置按钮在顶栏），详见 `scripts/dev-harness/README.md`。

### 目录结构

```
├── manifest.json          # TT 扩展清单（指向 dist 产物）
├── dist/                  # 构建产物（index.js / index.css ＋冒烟 chunk），随仓发布
├── src/
│   ├── main.ts            # 入口：浏览器宿主流 / node 冒烟流
│   ├── host/              # 宿主适配层——@sillytavern/* 导入的唯一合法区
│   ├── modules/           # 业务模块：choice（选项/池）、apis（统一端点）、persona、nav
│   ├── prompts/           # 提示词引擎：多任务模板、组装、外部注入
│   ├── shell/             # 工具箱壳：Vue 挂载、tab 框架、四个设置页
│   └── storage/           # 统一持久化服务
└── scripts/               # 质量门脚本与 dev-harness
```

关键约束：业务代码一律通过 `src/storage` 服务读写持久化（无服务原语的历史遗留操作如退役键删除除外，走 `src/host` 直访）、通过 `src/host` 适配层访问宿主 API——`@sillytavern/*` 裸导入只允许出现在 `src/host/`（由 `pnpm check-imports` 机器把关）。
