# dsh-worktree-guard

可选的 git worktree 守卫 DSH（DeepSeek Harness）插件。

> **宗旨**：把 worktree 从"模型的自觉"变成"宿主的结构"——隔离靠会话根（结构），安全靠单调收窄的常开网（兜底），授权靠带 TTL 的机械人闸（治理）。

完整设计（含宿主契约证据、七条裁决性原则、决策表、Agent 沟通面）见 [设计文档 v1.2](https://github.com/earneet/dsh-worktree-guard/blob/master/doc/design.md)。

## 它做什么

- **会话根模式（产品本体）**：`worktree_create` 建副本后，以副本为会话根新开会话 → DSH 沙箱自动锚定，写隔离即结构。
- **常开安全网**（是否绑定都生效）：跨副本写入、写 `.git`/状态区、push 受保护分支（master/main）、删 worktree 分支、`git -C` 定向到主根 → deny + 单轮可执行的指令。
- **读域守卫**：绑定态读主 checkout → 放行 + 溯源标记（默认 warn）或 deny（strict）——防止"写对地方、改错东西"。
- **机械人闸**：`worktree_authorize_main`/`worktree_allow` 走 pre-execute ask 门，模型无法自授；审批提示被禁用的会话（`approval=never`）改为带人工通道指引的 deny，并可用 CLI 交互式挑战完成授权。
- **收尾零债**：merge-base 证明式"已合并"判定、死绑定 prune、全树摘链接后再删副本（防 junction 穿透）。

## 守卫等级（诚实分级，P6）

| 等级 | 覆盖 |
|---|---|
| 结构拒绝 | 会话根沙箱写隔离；authorize ask 门 |
| 运行期挑战 | CLI `authorize-main` 的**一次性确认码**：机械校验，非结构边界、非身份认证——能读取该终端并注入输入的程序可重放（§14） |
| 词法启发 | pwsh 命令文本、路径归一化判域、读域守卫（8.3 短名/变量拼接可绕——raise the bar，非边界） |
| 纯纪律 | danger-full-access 下的一切（含任意脚本内容/直接写状态文件的绕过） |

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

会话内（插件加载后）使用 `worktree_create` / `worktree_enter` / `worktree_exit` / `worktree_status` 等工具；被拦截时按 deny 消息的"下一步"行动，或调用 `worktree_status`。

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

## 开发

```bash
node --test   # 决策表单测 + 真实临时仓库集成测 + 三轮对抗审查回归（见 test/）
```

零依赖纯 ESM（Node ≥20，Windows 优先适配）。

## 谱系

opencode-worktree-isolation（透明重写、Windows 归一化）× zcode-worktree-guard（默认开放、常开网、prune、204 用例方法论）× chuck-ma opencode-worktree-guard（merge-base、block-with-instruction）→ 按 DSH 实测契约（不可改写入参）重构为结构优先形态。详见 [设计审查记录](https://github.com/earneet/dsh-worktree-guard/blob/master/doc/design-review.md)。
