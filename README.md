# dsh-worktree-guard

可选的 git worktree 守卫 DSH（DeepSeek Harness）插件。

> **宗旨**：把 worktree 从"模型的自觉"变成"宿主的结构"——隔离靠会话根（结构），安全靠单调收窄的常开网（兜底），授权靠带 TTL 的机械人闸（治理）。

完整设计（含宿主契约证据、七条裁决性原则、决策表、Agent 沟通面）见 [设计文档 v1.2](https://github.com/earneet/dsh-worktree-guard/blob/master/doc/design.md)。

## 它做什么

- **会话根模式（产品本体）**：`worktree_create` 建副本后，`worktree_enter` 直接在本会话绑定副本（**采用模式**，无需新开工作区/会话）；以副本为会话根新开会话仍是可选的结构级升级。
- **指引按可达性分级（issue #4 + 用户反馈，0.2.4）**：`worktree_create`/`worktree_enter` 的"下一步"只给本宿主**探测到**的路径，且**会话内采用永远排第一**——不再要求人类用户先"添加工作区/新开会话"才能绑定；同时点名当前隔离等级（`worktree_status` 的 `isolation` 字段），不再把"纪律级降级"藏在从句里。
- **常开安全网**（是否绑定都生效）：跨副本写入、写 `.git`/状态区、删 worktree 分支、`git -C` 定向到主根 → deny + 单轮可执行的指令。push 受保护分支（master/main）默认拦截；**唯一放行例外（0.2.3，issue #1）**：未绑定会话、会话根就在主 checkout、且推送的是**当前所在**受保护分支 → 放行并写 `allow_protected_push` 审计。绑定会话、非当前受保护分支、`--force`/`--force-with-lease`/`--delete`/`--all`/`--mirror`/`+refspec` 仍拦；`--dry-run` 只读放行。
- **读域守卫**：绑定态读主 checkout → 放行 + 溯源标记（默认 warn）或 deny（strict）——防止"写对地方、改错东西"。
- **机械人闸**：`worktree_authorize_main`/`worktree_allow` 走 pre-execute ask 门，模型无法自授；审批提示被禁用的会话（`approval=never`）改为带人工通道指引的 deny，并可用 CLI 交互式挑战完成授权。
- **收尾零债**：merge-base 证明式"已合并"判定、死绑定 prune、全树摘链接后再删副本（防 junction 穿透）。

## 守卫等级（诚实分级，P6）

| 等级 | 覆盖 |
|---|---|
| 结构拒绝 | 会话根沙箱写隔离（写边界 = 会话创建时的 cwd）；authorize ask 门 |
| 运行期挑战 | CLI `authorize-main` 的**一次性确认码**：机械校验，非结构边界、非身份认证——能读取该终端并注入输入的程序可重放（§14） |
| 词法启发 | pwsh 命令文本、路径归一化判域、读域守卫（8.3 短名/变量拼接可绕——raise the bar，非边界） |
| 纯纪律 | danger-full-access 下的一切（含任意脚本内容/直接写状态文件的绕过）；以及**任何会话根不在副本上的状态** |

`worktree_status` 的 `isolation` 字段就是这张表的机器可读版：`structural` = 绑定且会话根就是副本、沙箱有围栏；其余一律 `disciplinary`（原因见 `isolation_reasons`：`no-binding` / `adopted-copy-not-root` / `binding-root-mismatch` / `sandbox-unfenced` / `sandbox-mode-unknown` / `unbound-with-copies`）。**采用模式（0.2.4）**恒为 `disciplinary`：守卫把工作路由进副本（deny 文案直接给出副本前缀重试路径；`bash -c 'cd <副本> && …'` 的相对 cd 在判定视图里按副本判），但会话根/沙箱写边界没有移动——诚实分级，不冒充结构隔离。

已知边界详见 [设计文档 §14](https://github.com/earneet/dsh-worktree-guard/blob/master/doc/design.md#14-已知边界p6-分级词汇写进-readme)。

## 安装与使用

DSH 插件（package.json `dsh.bundle.patch` → [cordis.patch.yml](cordis.patch.yml)）。已发布到 npm 后：

```bash
# 安装到 profile（CLI）
dsh plugin --profile web add dsh-worktree-guard
# 或 GUI 设置 → 插件 → 安装 bundle：dsh-worktree-guard
# 验证已挂载（应看到 worktree-guard 条目）
dsh web --dump-config
```

安装后变化：未绑定会话零注入、行为不变；`worktree_*` 工具出现在会话中；git 误毁防护（push 主干/删 worktree 分支/写 `.git` 等）常开生效。

```bash
# CLI（与原生工具同一 core）
node wt.js create fix-login --brief "修复登录"
node wt.js status
```

会话内（插件加载后）使用 `worktree_create` / `worktree_enter` / `worktree_exit` / `worktree_status` 等工具；被拦截时按 deny 消息的"下一步"行动，或调用 `worktree_status`（它的 `isolation` 字段说明当前隔离等级，`next_actions` 只列本宿主探得到的路径）。

配置 sidecar：**主 checkout 根**的 `<repo>/.dsh/worktree-guard.json`（`protected_branches`、`read_policy`、`branch_prefix`、`main_write_whitelist`、`sync.*`、TTL 等，snake/camel 键均可；设计 §13）。注意 `main_write_whitelist` 为 **glob 全匹配**（如 `"docs/*"`、`"gen/**"`）；目录前缀不带通配符（如 `"docs/"`）不会命中。

## 授权与人闸（含审批被禁用的会话）

- `worktree_authorize_main` / `worktree_allow` 由 `tools/pre-execute` 返回 **ask**，宿主弹确认框；模型无法自授。**审批策略为 `never` 的会话**（切到 `danger-full-access` 权限预设时宿主会把 approval 设为 never，无人值守/CI 也常见）**没有确认通道**：宿主会在任何人被询问之前直接判为拒绝，模型侧看到的是 `the user rejected tool`——**它不等于用户反悔**。
- 插件会在 pre-execute 读取宿主审批服务的会话策略；命中 `never` 时不再返回注定失败的 ask，而是返回带指引的 **deny**。若 ask 仍被宿主拒绝（策略在调用间隙变化、无可用应答者等），post-execute 会按重新探测到的策略补一行归因提示。两者都指向下面的人工通道。
- 审批被禁用时的降级路径（按推荐顺序）：
  1. **用户手动** `git push` / 合并（最简单）；
  2. 用户在**自己的交互式终端**、**目标仓库目录**下授权（CLI 从 cwd 解析仓库，所以 cwd 必须是目标仓库）：
     - 源码检出：`node <插件检出目录>/wt.js authorize-main "<原因>"`；
     - npm 安装到 profile：`node "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-worktree-guard\wt.js" authorize-main "<原因>"`（`≤0.2.1` 的已发布包中文件名为 `wt.mjs`；profile 名以 `~/.dsh/profiles/` 下实际目录为准）；
     - 命令会要求输入终端显示的**一次性随机确认码**（60 秒超时；固定短语不能通过——防程序化控制台里的环境输入），未确认不写入任何授权。**该确认码 0.2.2+ 才有**：`≤0.2.1` 的包只做 TTY 检查，没有这层挑战。
  3. 切换到会弹确认的权限预设/开启审批提示后重试。
- `wt` 这个 bin 名在 Windows 上可能与 Windows Terminal 的 `wt.exe` 冲突（PATH 中 WindowsApps 常优先）；请按上面的 `node <路径>/wt.js` 形式显式调用，或使用 `npx --package dsh-worktree-guard wt ...`。
- CLI 授权写入 `<git-common-dir>/worktree-guard/state.json`，是**仓库级 TTL**：对本仓库**所有会话、所有关联 worktree** 生效（不是会话级）；`node <路径>/wt.js revoke-main` 立即收回，`--ttl-minutes` 可缩短（缺省读 sidecar `authorize_ttl_minutes`）。
- 聊天里"用户已同意"**不构成**机械授权证据（P4）：要么审批弹窗确认，要么用户在自己的终端授权。
- **CLI 确认码是"运行期挑战"，不是结构边界**：它由插件机械校验，只证明"有东西在该终端键入了显示出来的码"；能读取控制台缓冲区并注入键盘输入的程序可以重放（与任意代码执行同级，见设计 §14.3）。真正的结构级人闸仍是宿主 ask 门。
- shell 词法网对包含 `authorize-main` 字面量的命令**默认整条拦截**（fail-closed：原文与归一化视图都查）；唯一例外是**纯只读检查链**——`Select-String`/`grep`/`rg`/`Get-Content`/`git log|grep|show…` 等只读段用 `;`、`|` 或换行串联，且**不含**脚本块/命令替换、文件重定向（`2>&1` 这类 fd 复制除外）、内联执行 flag（`rg --pre`、`git grep -O…`、`--output` 等）。提交信息、`Write-Host`/`echo` 写入型命令、变量拼接、别名调用仍会被拦或属已知边界（设计 §14）。
- **仓库安全配置**（`<repo>/.dsh/worktree-guard.json`）由用户维护：`write`/`edit` 工具对它的写入被 deny（shell 直写仍属 §14 词法边界）；`protected_branches` 只增不减（默认 master/main 始终受保护），避免"改配置关掉 push 网"。确需改配置请用户手动编辑。
- **push 主干的死路已消除（0.2.3，issue #1）**：在**未绑定**、会话根就在主 checkout 上工作的普通"提交并推送"场景，`git push origin master` / `git push` / `git push origin HEAD:master` 现在直接放行并写审计（这是用户自己的主干工作流，不是副本误推主干）。以下仍被拦截：绑定副本会话的受保护分支推送、推送非当前受保护分支、`--force`/`--force-with-lease`/`--delete`/`--all`/`--mirror`/`+refspec`；`--dry-run` 在任何状态放行（只读）。不满足放行条件时，deny 文案会说明是"绑定会话 / 非当前分支 / 破坏性选项"，并明确 `worktree_authorize_main` 在 `approval=never` 会话中不可用，不再制造"提示调 A、A 必失败"的闭环。**前缀不绕过**：`git -C/-c/--git-dir/--no-pager` 等全局选项、`git.exe`、`command/env/time/FOO=1` 前缀会先归一化再判定；带全局选项的受保护分支 push 直接 fail-closed（可能改道其他仓库），运行时拼接/变量 refspec 同样 fail-closed。
- **引号内文本不再误当命令位（0.2.3，issue #1 残余）**：`git commit -m "(git push origin master)"`、`git commit -m "fix; git push origin master"`、宿主输出里的 `(git push ...)` 不再被拦截；但 `$()` 命令替换、`cmd /c` / `pwsh -Command` / `iex` / `bash/sh/zsh/dash -c` / `eval` 的引号参数仍按**代码**递归检测，常见脚本宿主（`node -e`、`python -c`、`perl -e`、`ruby -e`、`php -r` 等）的引号代码参数同样不放过，多行/分段命令与引号拼接也照旧拦截。`authorize-main` 字面动词仍对原始文本 fail-closed（`node wt.js "authorize-main"` 是真实 argv 路径，P4 自授防护），`git "checkout" main` 这类"引号里的真实 argv"也不放宽——见设计 §14。
- **worktree_remove 参数错配修复（0.2.4，issue #5）**：工具 schema 的 `confirm_remove`/`delete_branch`（snake_case）此前经 `...args` 裸透传给 camelCase 形参的 `lifecycle.remove`，确认参数永远到不了——工具只能无限返回"需确认"。现已显式映射（与 create/prune/authorize/allow 一致），并新增全工具参数映射一致性回归（源码级禁止 `...args` 裸透传 + 工具层 snake_case 冒烟）。
- **过期绑定诊断（0.2.3，issue #2/#3）**：`git -C` 指向已删除的副本路径时，deny 会说"路径已不存在（可能曾是被清理的副本）"并指向 `worktree_status`/`worktree_prune`，而不是误报"指向主 checkout"；`worktree_status` 与 `worktree_prune` 共用同一过期谓词，status 直接列出 `stale_bindings` 并给出 `worktree_prune` 动作，prune 同时清掉指向已消失路径的 `state.json.last_active`。
- **副本会话指引按可达性分级（issue #4；0.2.4 按用户反馈重构）**：初版（未发布）曾把"GUI 添加工作区→新建会话"列为推荐路径；用户明确否决——目标是让 Agent 正确工作在对应分支，而不是要求人类先切工作区。0.2.4 起 `worktree_enter` 对**嵌套在会话写边界之内**的副本（默认布局 `<repo>/.worktrees/…`）直接**就地采用**（`mode:"adopted"`）：
  1. `worktree_enter{path}` 立即绑定，无需任何宿主侧操作；宿主自己的 worktree 服务存在时（`ctx.worktrees`）改走 `switch_session:true` 让宿主移动会话目录；
  2. 采用后 write/edit/搜索用 `.worktrees/<副本名>/` 前缀路径（在会话写边界之内，沙箱接受）；落在主 checkout 的相对路径被 deny，且 deny 文案直接给出副本前缀的重试路径（C1：pre-execute 不能改写入参，所以由模型自己重试）；
  3. shell 里用 `bash -c 'cd <副本> && …'`（相对 cd）：判定视图先把相对副本词读成副本路径，`git` 命令按副本分支判定（受保护分支 push 仍拦），post-execute 留"采用模式"标记（P3）；
  4. 真·结构隔离仍是可选项（GUI 添加工作区 / 以副本为根的新会话），不再作为前置条件。

  副本在会话写边界**之外**（自定义 `worktree_parent` 指到别处等）且沙箱有围栏时，绝对路径写副本确实会被沙箱拒绝——此时 deny 追加一行"副本在会话写边界之外"并给出宿主侧路径。`danger-full-access` 下没有任何围栏，等级恒为纪律。

## 开发

```bash
npm test              # 决策表单测 + 真实临时仓库集成测 + 回归（见 test/）
npm run verify:package # 打包冒烟：npm pack → 解包 → 跑发布的 wt.js / CLI_PATH / 非 TTY 门禁
```

`npm test` 经 `scripts/run-tests.mjs` 启动，仅为测试里创建的临时仓库临时关闭 git fsmonitor（Windows Git for Windows 的系统配置默认 `core.fsmonitor=true`，并发创建 worktree 时可能卡死在 `git reset --hard`）；不修改用户 git 配置。CI 在 ubuntu-latest 与 windows-latest 上跑全量测试，另跑打包冒烟；release 工作流在发布前校验 `v<tag>` 与 `package.json` 版本一致。

零构建纯 ESM（Node ≥20，Windows 优先适配）；唯一运行时依赖是宿主提供的 `@deepseek-ai/schemastery`（DSH 插件 Config 契约），无其他第三方依赖。

## 谱系

opencode-worktree-isolation（透明重写、Windows 归一化）× zcode-worktree-guard（默认开放、常开网、prune、204 用例方法论）× chuck-ma opencode-worktree-guard（merge-base、block-with-instruction）→ 按 DSH 实测契约（不可改写入参）重构为结构优先形态。详见 [设计审查记录](https://github.com/earneet/dsh-worktree-guard/blob/master/doc/design-review.md)。
