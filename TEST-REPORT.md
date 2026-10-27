# dsh-worktree-guard 完整功能测试报告

日期：2026-10-14 ｜ 环境：Windows / Node v24.15.0 / git 2.45.1.windows.1 ｜ 总结果：**全部通过（round-13 后全量 163/163）**

## 审批禁用会话修复轮（round-13，issue #1 驱动）

GitHub issue #1（审批策略 `never` 的会话中 main 推送死路 + shell 词法网误伤文档检索）经宿主源码与事故会话日志实证后修复：

- **ask 门必败检测（行为，高）**：宿主 `dsh-user-approval` 在 `policy:"never"` 时于应答者 waterfall **之前**确定返回 `rejected`，`dsh-tools` 统一渲染 `the user rejected tool "X"`（无弹窗）——事故会话（2026-10-27）中三次调用均在 1ms 内 `asked`+`decided:"rejected"`，证实不是用户反悔。插件新增 pre-execute 能力探测 `ctx.get("approval")` → `overrideOf(session) ?? config.policy`；命中 `never` 时返回三段式 deny（人工 CLI / 手动推送 / 切换预设），不再制造"提示调 A、A 必失败"的死循环。post-execute **重探测策略**后对 gated 工具被拒补一行归因标记（区分"审批禁用"与"可能真被用户拒绝"两种措辞，并按工具给对应降级路径）。
- **文案补降级路径（高）**：受保护分支 push（显式/隐式/包装三条）的"下一步"用**简版**人工提示（避免每次重复 ~300 字符条件句）；`authorize-main` 词法 deny、gated 工具的 deny/marker、工具描述内嵌**由模块位置解析出的绝对 CLI 路径**（profile 安装也单轮可执行）与"目标仓库 cwd + 终端随机确认码"细节；CLI 非 TTY 报错同步。
- **authorize 动词误伤修复（中，已按对抗审查返工）**：第一版把规则收窄为"调用位置"，对抗审查证明这是安全回退——程序化新建控制台（`Start-Process`/`conhost`/python `CREATE_NEW_CONSOLE`）会让子进程拿到真 TTY 并写授权，而旧规则对字面动词全覆盖。最终实现：**字面动词在原始与归一化视图中都 fail-closed**（拼接/包装一网打尽），唯一例外是**纯只读检查链**（`Select-String`/`grep`/`Get-Content`/`git log…` 经 `;`/`|`/换行串联，且不含脚本块、命令替换、文件重定向（`2>&1` 除外）、`Write-Host`/`echo` 写入型命令、`rg --pre`/`git grep -O…`/`--output` 等内联执行 flag）。同时把 CLI 从"仅查 isTTY"升级为**键入本次随机确认码 + 60s 超时**（未确认/错误码/EOF/流错误一律不落授权）。
- **审计外溢修复（中，round-13 对抗审查发现）**：① 状态区词法洞——`cd .git/worktree-guard` + 相对 `Set-Content state.json` 曾可伪造授权，已把目录匹配的**尾部分隔符改为可选**并加回归（分段 `cd .git` 再 `cd worktree-guard` 仍未拦，属 §14.3 边界）；② sidecar `protected_branches` 曾可被配置**移除** master/main 从而关掉 push 网——改为**只增不减**（P1），且模型的 `write`/`edit` 对 `.dsh/worktree-guard.json` 一律 deny（shell 直写属 §14 词法边界）；③ `revoke` 收敛进同一 [src/core/authorize.js](src/core/authorize.js) grant/revoke 路径；④ 插件 Config 自定义 `protectedBranches` 不再丢默认 master/main（P1 union 在首次 context 构建前完成）。
- **作用域与等级文档化（中）**：CLI 授权写入 `<git-common-dir>/worktree-guard/state.json`，**仓库级 TTL**、对本仓库全部会话/关联 worktree 生效（实测两个不同 session 均 allow）；README 新增"授权与人闸"章节与 P6 "运行期挑战"等级（明确非结构/非身份边界，可被控制终端的自动化重放）；`≤0.2.1` 无确认码一事写明。
- **架构收敛（低）**：主分支 grant/revoke 收敛为 [src/core/authorize.js](src/core/authorize.js) 唯一路径（TTL 钳制 + state + 审计一处），ask 门工具与 CLI 共用；人证以 `confirm` 回调注入（工具=上游 ask 已确认，CLI=键入随机码），"未确认绝不落授权"可单测而不依赖控制台。CLI 人证与路径解析独立为 [src/core/human-gate.js](src/core/human-gate.js) / [src/core/cli-path.js](src/core/cli-path.js)。
- **测试**：新增 [test/round13-regressions.test.js](test/round13-regressions.test.js)（26 项：误报防线 / 启动器·多行·拼接仍拦 / 策略探测与装配 wiring（含"非 gated 不探测"spy）/ post-execute 标记措辞 / CLI 键入确认（含错误流 fail-closed）/ 授权 grant+revoke 单路径与 TTL 钳制 / 文案预算契约 / 状态区·sidecar·插件 Config 自授面）；全量 `npm test` → **163/163 pass**。CLI 人证另做**手工**对照观察（非自动化断言）：程序化控制台（`cmd /c start /wait`）中，旧实现仅查 `isTTY` 即落授权；新实现要求键入终端显示的确认码。把"要求码"藏起来仅经 argv 传入属于诊断变体、不是发布 CLI 的路径，连续两次观察无任何输入（`raw=""`）并超时；发布形态下只有读到显示码并键入者才通过——**不构成"环境绝不会注入"的自动化证明**，等级按 P6 记为运行期挑战。

## 文案对抗审查轮（round-9，三路子代理独立审查后统一实施）

对五通道全部模型可见文案（常驻行/session-start/deny/ask/工具描述/技能/工具输出）做三路对抗审查（精准度/认知效率/round-8 一致性），修复清单：

- **行为矛盾（高）**：① danger-full-access deny 文案原称"仅剩纯纪律级防线"，与实现（非 worktree_* 工具全部硬 deny）矛盾，改为如实描述工具级全拒 + 两个出口；② create 输出"继续本会话并遵守相对路径纪律"是陷阱（创建会话未绑定，相对路径落主 checkout 且放行），改为"务必用指向副本内的绝对路径"；③ **CLEANUP_SKILL 第 3 步教模型手动 `git branch -d`，而词法网规则 3 对此一律 deny**——技能在引导模型撞自己的守卫，改为点名 worktree_authorize_main + 分支删除交给 exit remove。
- **规则自相矛盾（高）**："读写一律用相对路径"（session-start）vs deny 下一步"相对或绝对均可"——全局统一为"路径必须解析到本副本内"。
- **动作指针（高）**：收尾链全部点名工具与终点（status → authorize_main → exit remove）；ask 门消息去掉内部术语"P4 机械人闸"、按工具名泛化（allow 触发不再误导为 authorize_main）。
- **包装拦截专属文案（中）**：经拼接/包装命中的 push 不再复用通用原因（防"误报→换包装重试"）；措辞效果导向、不枚举检测维度（不泄露防御细节）。
- **其余**：statusDesc 删实现细节（git merge-base 命令名）+ 补 unbound 动作；exitDesc 消歧 "(merged branches only)" + 补 guard 文件不算脏；跨副本 deny 拆绑定/未绑定双模板（未绑定也拦是常开规则，原文案说"本会话绑定"是假话）。
- 断言同步：round1/round5 文案契约断言更新（守则匹配"本副本"、收尾链必须含 worktree_authorize_main）；常驻行"拦截/标注"经三路复审一票改两票不改（行为精确、预算内），保持不动。

## 加固轮（round-8，独立复审后按优先级迭代）

依据综合复审三项建议完成迭代，新增 [test/round8-hardening.test.js](test/round8-hardening.test.js)（17 项）并入 `npm test`：

- **词法网收紧（单一归一化 seam）**：`cmd /c`、`pwsh -Command`、`iex` 嵌套包装，`git pus""h`/反引号拼接，`$(...)` 子表达式，多行脚本第二行 push——全部入网；误报防线（echo/commit 信息含 push 字样、`cmd /c "git status"`、push 本分支）不回退。关键动机：**push 是网络操作，rooted 沙箱无兜底，词法网是唯一防线**。guard-module/state-area 规则保持测原文（引号形态依赖，R4-1 验证）。
- **C8 落地**：经宿主 Cordis Inspect Event 目录实证 `agent/disposed`（emit，payload `{agent}`）；[index.js](src/index.js) 挂监听——disposed 为本会话绑定盖 `resolved_at`（幂等、不删：resume 友好，prune 终删；监听自 catch，emit 回调不得破坏宿主）。C10 能力面同步实证（`agentLoop.create(id, options, meta: Pick<SessionHeader,'cwd'>)`），实际调用冒烟仍后置。
- **junction 摘链删除集成测试（R8-D）**：sidecar `symlink_dirs` 声明链 + 未声明 rogue 链 → remove 前全树摘链，主根两侧目标内容完好（防 `git worktree remove` 递归穿透）；配套修复 `isDirtyForLifecycle`：未跟踪 symlink/junction 不计脏（链接非用户内容、删除前必被摘除），未跟踪真实文件照常计脏（R8-D2 防掩蔽）。


## 独立复测轮（同日，独立于原测试资产）

在原有三层之外，用**新写的一次性脚本**（不复用既有测试代码路径）对守卫核心做独立实测，9/9 通过：

- 写域：本副本相对写 allow；跨副本绝对路径 / `.git` 元数据 / `..\` 逃逸均 deny 且给出"下一步"指令（M1–M4）。
- shell 词法网：push 受保护分支 deny、push 本分支 allow、`git -C` 定向主根 deny、绑定态 `checkout main` deny、`npm install` 无误报（M5–M9）。

环境注意：DSH 沙箱内 `node --test` 与子进程管道 spawn 会 EPERM/受限，完整实测需在非受限执行面运行（本次经授权后执行）。

## 迭代轮（round-7，报告同日完成）

依据下表发现 #2/#3 完成迭代，新增 [test/round7-iterations.test.js](test/round7-iterations.test.js) 3 项回归：

- **#2 修复**：`isDirtyForLifecycle`（[gitops.js](src/core/gitops.js)）在 remove/status 判定时忽略**未跟踪**的插件自有 `.dsh/` 文件；已跟踪的用户改动照常计脏（R7-3）。`git worktree remove` 层改为闸门通过后始终 `--force`（我们的闸门是权威 dirty 判定，剩余未跟踪文件必为插件自有）。新建副本现在无需 `--force` 即可 remove（R7-1）。
  - 迭代中被 R7-2 否决的方案：写 per-worktree `info/exclude` —— 实测 `git rev-parse --git-path info/exclude` 在 worktree 内解析到**共享** exclude，会波及主 checkout 的 status 语义；改为判定层方案，零仓库状态副作用（R7-2 验证共享 exclude 未动、`isDirty` 原语义保留）。
- **#3 文档**：README 白名单说明补充 glob 全匹配语义（`"docs/*"` 命中、`"docs/"` 不命中）。


## 测试范围与结果

| 层级 | 方式 | 结果 |
|---|---|---|
| 1. 现有测试套件（决策表单测 + 集成 + 6 轮对抗回归） | `npm test` | ✅ |
| 2. 守卫决策网全路径 + 插件装配层 | 新增 [test/e2e-guard-live.test.js](test/e2e-guard-live.test.js)（27 项） | ✅ 27/27 |
| 3. CLI 端到端（真实临时仓库，wt.js 全命令） | 新增 [test/e2e-cli-run.ps1](test/e2e-cli-run.ps1)（23 项） | ✅ 23/23 |
| 4. 迭代回归（round-7） | 新增 [test/round7-iterations.test.js](test/round7-iterations.test.js)（3 项） | ✅ 3/3 |
| 5. 加固回归（round-8） | 新增 [test/round8-hardening.test.js](test/round8-hardening.test.js)（17 项） | ✅ 17/17 |

全量回归：`npm test` → **132/132 pass**（round-7/8 已并入套件）。

## 守卫网覆盖（G 系列，经 decideToolCall 实测）

- **写域**：相对路径写本副本 allow；空路径/跨副本/`.git` 元数据/状态区 deny；**junction 指向主 checkout 的写入被物理身份识别并 deny**（G5）。
- **读域**：warn 模式读主 checkout → allow + 溯源标记（经 `takePendingMark` 按 callId 取走且一次性）；grep 搜索主根同样标记；sidecar `read_policy:"strict"` → deny。
- **shell 词法网**：push 受保护分支 deny / push 本分支 allow；主根裸 push deny；`git branch` 涉 worktree 分支 deny（诱饵多分支亦命中）；`git -C` 绝对路径定向主根 deny；绑定态 `checkout main` deny；shell 内 `authorize-main` 动词 deny（人工通道保护）；`Set-Content ../../.git/worktree-guard/...` deny；import 守卫模块 deny；日常命令（npm/Get-ChildItem/引用 store.js 的普通参数）无误报。
- **C9 沙箱链路**：绑定 + `danger-full-access` → 非生命周期工具 deny、`worktree_*` 豁免（逃生门不被自锁）。
- **授权治理**：TTL 有效期内写主 checkout + push 放行，过期后自动收回（G18）；sidecar `main_write_whitelist` glob 放行。

## 插件装配层（P 系列，mock cordis ctx 跑 apply()）

- worktree_* 六工具注册齐全；pre-execute deny/ask 决策正确且 deny 时不调 next。
- post-execute 将读域溯源标记附加到 `additionalContexts`；standing line 每绑定会话只注入一次；session-start 引导对 rooted 会话及 **parentSession 继承会话**均生效；`enable:false` 零挂载。

## CLI 端到端（C 系列，真实临时仓库）

help / create（含 task-brief 与 skill 写入）/ status（unbound→rooted→repo-rooted 模式）/ enter / exit / remove（needConfirm 门、dirty 拒绝、merged-only 分支删除证明流）/ prune（dry-run 与实删）/ authorize-main **非 TTY 拒绝**（exit 1）/ revoke-main / 未知命令 exit 2 / 状态区审计落盘。

## 发现与处理

| # | 发现 | 定性 | 处理 |
|---|---|---|---|
| 1 | `node --test test/` 目录形式在 Windows/Node 24 下 MODULE_NOT_FOUND，`npm test` 不可用 | 测试脚本 bug | ✅ 已修复：package.json 改为 `node --test "test/*.test.js"` |
| 2 | `create` 写入的 `.dsh/`（task-brief、skill）未跟踪 → 新建副本恒 dirty → 不加 `--force` 时 `remove` 必被"未提交变更"拒绝 | 可用性问题 | ✅ round-7 已修复：`isDirtyForLifecycle` 忽略未跟踪插件自有文件；git 层 remove 由权威闸门接管 |
| 3 | `main_write_whitelist` 仅 glob 全匹配：`docs/`（目录前缀）永不命中，需写 `docs/*` | 语义注意点 | ✅ README 已补充说明；G19 固化为断言文档 |

## 结论

三层实测（决策核心、插件装配、CLI 人机面）+ 迭代回归全部通过；测试报告中的三项发现均已在 round-7 迭代中处理。测试资产已入库：`test/e2e-guard-live.test.js`、`test/round7-iterations.test.js`（并入 `npm test`）、`test/e2e-cli-run.ps1`（手动 E2E，PowerShell）。
