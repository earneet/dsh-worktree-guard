# dsh-worktree-guard 设计文档审查报告

> **审查对象**: [doc/design.md](design.md)（v0.1 设计稿，2026-10-12）
> **审查方法**: 设计文档的全部宿主契约假设（C1–C7）逐条对照本机安装的 DSH 运行时代码实证（`C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\*`，dsh 0.1.5-rc.3）；三个前辈插件逐一源码/实物核对（本地 opencode 插件源码、zcode 插件全量源码、chuck-ma npm 0.3.7 tarball）。
> **审查结论**: **设计哲学与谱系引用准确，但核心机制假设（C1 参数改写）被宿主实测反驳，设计必须转向**——从"透明重写"转向"拒绝式守卫 + 会话根模式为主推"。转向路径文档已预留（C1 降级条款），但整个 §0/§2/§5 的重心需要翻转。

---

## 1. 最重要的发现：C1 的"改写"半边被反驳

设计文档的灵魂是 §0 的"**写路径透明重写到副本**"。实测结论：

| 路径 | 改写能力 | 证据 |
|---|---|---|
| CC 方言 hooks.json 桥（`dsh-hooks-claude-code`） | **不可** | `dsh-hook-protocol/lib/types/types.d.ts:126-130`：`updatedInput` "PARSED but NOT honored"；运行时警告 "hook requested updatedInput, which is not yet honored (ignored)"（`dsh-hooks-claude-code/lib/index.js:192`）。README 明示这是**有意的延期设计**，不是 bug |
| 原生 cordis 插件 `tools/pre-execute` | **不可** | `dsh-tools/lib/index.js:3059`：`arguments: deepFreeze(detached)`——入参物化后深冻结；README:224 明示 "`tools/pre-execute` **deliberately cannot rewrite `exec.arguments`** — logged and rendered args would diverge" |
| 原生 `tools/execute` 包裹重派 | **技术上可行，但对抗设计** | waterfall 终端默认 `() => this.dispatchToolBody(mutableExec)` 只是兜底（index.js:3213），插件可跳过 `next()` 自行返回结果。但 DSH 冻结参数的理由（日志/渲染与实际执行分歧）同样适用于此——属于"能用但不该用"，且随时可能被上游收紧 |

**含义**：zcode 的 `updatedInput`（zcode 引擎支持全量替换并重新过 schema 校验）和 opencode 的 `event.input` 原地改写（[src/v2.ts:118-129](../../opencode-worktree-guard/src/v2.ts#L118-L129)），在 DSH 两条钩子路径上**都不存在**。DSH 的哲学是"拒绝并给理由，让模型重试"，不是"静默改写"。

### 1.1 但存在一条文档未探索的改写缝：`ctx.fs` 服务层

`ctx.fs` 是可挂载的后端服务（fs-local / fs-sandbox 同一接口）。`dsh-fs-sandbox` 的 README 明示"挂载此后端**代替** fs-local"是受支持的组合方式。因此：

- **一个包裹型 fs 后端**（委托 fs-local，但对路径做 R→W 归一化重映射）可以一次性、统一地恢复 read/write/edit/glob/grep 的透明重写——而且比工具层改写更干净：glob/grep/search 都走 `ctx.fs`。
- pwsh/bash 是独立进程，**不走 `ctx.fs`**——shell 写盘仍是洞，需命令文本守卫 + shell 沙箱对冲（与 §12 现有诚实清单一致）。
- 风险：与 `dsh-fs-sandbox` 的挂载互斥/叠加关系、与 read-before-edit 观察策略插件（`dsh-fs-observation-policy`）的交互顺序，都需要 M0 实测。

**建议**：把这条缝作为新的 **C1b** 假设写进 M0 清单；同时向上游提 feature request——CC 钩子协议已经解析 `updatedInput`，只差 honor，一个上游 PR 即可让本设计回归原形。

## 2. C1–C7 逐条判定（对照实测）

| # | 设计假设 | 判定 | 关键证据 |
|---|---|---|---|
| C1 | 前置钩子可拦截**并改写**参数 | **拆分判定**：拦截 ✅；CC 钩子改写 ❌；原生 pre-execute 改写 ❌；tools/execute 重派 ⚠️ 对抗设计；ctx.fs 后端包裹 💡 待验证（见 §1.1） | 见 §1 |
| C2 | 钩子可读 session id / 工作区根 / 工具名与全参 | ✅（原生比 CC 载荷更富） | CC 载荷构造 `dsh-hooks-claude-code/lib/index.js:347-374`（`session_id`/`cwd`/`tool_name`/`tool_input`，注意 `transcript_path` 恒为空串）；原生监听器直接拿整个 `exec`（含 `agent.session.header.cwd` 与 `parentSession`） |
| C3 | pwsh `workdir` 由 harness 解析 → 钩子可改写 | 前半 ✅ 后半 ❌。`resolveWorkdir` 确以会话 cwd 解析相对 workdir（`dsh-tool-pwsh/lib/index.js:150-155,368`）——"DSH 独有资产"的事实判断正确；但参数冻结使改写同样不可行 | 同 C1 |
| C4 | 插件可注册自定义工具 / skill | ✅ | `tools.register()`（`dsh-tools/lib/index.js:2780`）；`ctx.skills.registerProvider`（`dsh-skill-filesystem/lib/index.js:30-48`），且文件系统 provider 自动发现项目 `.dsh/skills`、`.agents/skills`、`~/.dsh/skills`——**worktree 自带技能零代码生效**，这是文档没发现的资产（见 §5.3） |
| C5 | 提示注入点存在 | ✅ 且比设计假设的更细 | 四档粒度：SessionStart additionalContext（`agent.inject`）、每步 `agent/pre-step`、每工具结果 `tools/post-execute` additionalContexts、常驻策略段（`dsh-sandbox-policy/lib/index.js:53-56` 模式，不改稳定系统提示） |
| C6 | 子代理走同一钩子且可辨父子 | ✅（**仅原生路径**） | 子代理工具调用过同一 waterfall，`exec.agent.session.header.parentSession` 记录父 id（`dsh-subagent/lib/index.js:502-508`），`liveLineage` 可走父链（:1043-1049）。CC 方言的 SubagentStart/Stop 只有 `agent_id`/`agent_type`，**无父 id**——再次要求原生 cordis 插件形态 |
| C7 | 钩子异常/超时行为 | ✅ 已查明，且与设计 §9 的假设不同 | **原生插件 throw = fail-closed**（waterfall try/catch 直接返回 `toolErrorResult`，工具体不执行，模型看到错误，`dsh-tools/lib/index.js:3114-3155`）；**CC 命令钩子崩溃/超时 = fail-open**（非 2 退出码放行，`dsh-hook-protocol/lib/index.js:187-211`，默认超时 600s）。设计 §9"分工具 fail 策略"需要重写：fail-closed 是白送的，fail-open 才需要插件自己 try/catch 吞错 |

## 3. 第③层（沙箱协同）的表述需要收口

设计 §4 称会话根 = worktree 时"写主 checkout = **物理拒绝**"。实测更精确：

- fs 工具（write/edit）：✅ 成立。`dsh-sandbox-policy` 以 `SessionHeader.cwd` 解析 workspaceRoot（`lib/index.js:141-145`），`dsh-fs-sandbox` 对 write/edit 做词法前缀 + dev/ino 身份兜底的围栏。
- 但要打两个折扣：
  1. **它自述为 "containment, not a security boundary"**——内核级隔离是 `ctx.shell`（进程沙箱）的职责。pwsh/bash 进程的写盘约束在另一层。
  2. **模式可运行时切换 + 提权授权**："A session's mode can be switched at runtime through a UI policy control or an explicit switch"（`dsh-sandbox-policy/README.md:54`）；`danger-full-access` 一切归零（本审查会话自身就处于该模式，即为实证）。

**修订建议**：安全网（§2 常开层）必须新增两条 DSH 特有规则：
- 监听/检查沙箱模式与提权（guard 不能被"切到 danger-full-access"静默绕过——至少在绑定态下 deny 或告警）；
- 会话根模式下 pwsh 命令文本守卫仍是必要的（fs 围栏不覆盖进程写盘）。

顺带：`dsh-sandbox-windows-acl` 包存在（本机亦有 `diagnose-windows-sandbox-acl` 技能佐证 Windows ACL 修复路径），Windows 下沙箱实现是 ACL 型——设计 §10 的 Windows 适配一节可以引用这个事实。

## 4. 谱系核对（§15）：无虚假继承，两处需加注

逐项核对三个前辈实物，设计文档的归因**全部属实**：

- **opencode-worktree-isolation**（本地 `F:\workspace_2\opencode-worktree-guard`）：透明重写 ✅、读路径修正 ✅、Windows 归一化（`\\?\` 剥离/大小写/分隔符，`src/lib.ts:167-183`）✅、allowlist/TTL ✅。**加注 1**：`[worktree]` 可见标记**只覆盖 bash 命令改写**（`lib.ts:219-248`，issue #11 的误归因场景就是 shell 输出），write/edit/read 改写是静默的——设计 §5 把它放在 pwsh 行内，恰好一致，但若将来泛化到文件工具需自行新增（DSH 的 `tools/post-execute` additionalContexts 正好是现成注入缝）。
- **zcode-worktree-guard**：默认开放哲学、常开安全网、authorize-main（15min TTL，缺失 TTL 视为过期）、死绑定 prune、never-block-owner、link_scan "all" 全树 lstat+unlink、DB parent 链继承、204 用例决策表方法论——全部在源码中核实（`guard_hook.mjs`、`common.mjs`、`wt.mjs`、`tests/v2.test.mjs`）。§4.2 "node 不可用"误判教训属实。
- **chuck-ma opencode-worktree-guard**（npm 0.3.7 tarball 实读）：merge-base `--is-ancestor` 合并验证解锁 ✅（`worktree_done`，squash/rebase 需 `force:true`）。**加注 2**：GitHub 仓库名是 `chuck-ma/opencode-config`（`chuck-ma/opencode-worktree-guard` 404）；且 0.3.5 起 postinstall 改写用户 opencode.json 锁版本——**供应链异味，只借鉴设计、不加依赖**是正确姿势，建议在 §15 明示。

## 5. 设计未充分利用的 DSH 资产

1. **`agent/pre-step` / `tools/post-execute` 注入**：比"SessionStart 一次性提示"更强的纪律通道——每次enter后的每一步都可低成本重申"你已绑定副本 X，相对路径即副本"；shell 重写通告的 DSH 等价物（opencode 的 execute.after marker）可用 post-execute 实现。
2. **项目级技能自动发现**（`.dsh/skills` 在 projectRoot 下）：`create` 时在 worktree 内放置 worktree-workflow 技能文件 → 副本自带"收尾清单"技能，主 checkout 零污染。zcode 用 `skills/worktree-workflow/SKILL.md` 做的事在 DSH 有更原生的落点。
3. **`tools/restrict()` / `ctx.tools.guard()`**：绑定态下可以用 restrict 收紧工具面（如禁 patch 类不可改写工具），guard 提供单调 owner 级策略——比逐条 pre-execute 判断更贴合宿主风格。
4. **会话标题**：opencode 版用 `🌿 branch` 标记会话（`core.ts:341`），DSH 有 `dsh-session-title` 体系，低成本高可见性。

## 6. 设计需修订清单（按影响排序）

1. **§0/§2/§4/§5 重心翻转**：会话根模式（rooted）从"推荐"升为**主推/默认产品形态**；仓库根模式（repo-rooted）降级为"受支持但以拒绝式为主"——因为读视图一致性（目标 3）在不能改写的宿主里对 repo-rooted 模式**整体不可达**（读主根=看主根世界，写主根=被拒，模型看到的和能改的永久分裂，这比静默改写更伤 agent 行为）。若要救回 repo-rooted 的透明性，唯一干净路径是 §1.1 的 ctx.fs 包裹后端（列为 M0 的 C1b 假设）。
2. **§5 决策表 pwsh 行**：删除"workdir 改写（C3）"与"命令串路径替换"，改为"残余主根路径 → deny + 指令性错误消息（ chuck-ma 风格的 block-with-instruction 比 zcode 的静默改写在 DSH 上更对味）"。
3. **§9 fail 策略重写**：原生插件 throw 即 fail-closed（白送）；文件工具保持 fail-closed = 不 throw 之外什么都不用做；只读工具要 fail-open 需要**插件自己 catch 并放行**；CC hooks.json 后备路径天然 fail-open——两套语义并存，建议干脆冻结为"仅原生 cordis 插件"，不提供 hooks.json 形态，消除混合语义。
4. **§2 安全网增补**：绑定态下的沙箱模式切换/提权 deny 或告警（§3 第 2 条）。
5. **§3 M0 清单更新**：C1 拆为 C1a（pre-execute 拦截，已实证 ✅ 可直接标定）、C1b（ctx.fs 包裹后端，新增待验）；C3 标记"前提事实成立、改写路径不成立，仅剩历史价值"；C7 标记已查明（含 600s 命令钩子超时）。新增：与 `dsh-fs-observation-policy` 的 read-before-edit 交互、fs 后端挂载顺序。
6. **§14 里程碑**：M0 大半已由本审查完成（可沉淀为《宿主契约证据》v0.1，引用本文件）；M1 定义需随 §6.1 翻转而改写。
7. **§15 加注**：chuck-ma 真实仓库名 + postinstall 供应链警示；`[worktree]` 标记仅 bash 的适用范围注记。

## 7. 保留意见（设计做对了的）

- **契约证据先行的方法论**被本次审查直接验证了价值——C1 正是"写一行代码前必须实测"拦下的那个假设。
- 保护/隔离解耦、常开安全网、硬规则代码常量、状态存 git-common-dir、merge-base 显式验证、junction + link_scan——全部经受住了三个前辈实物的交叉检验。
- 选择 cordis.patch.yml bundle 原生插件形态（而非 hooks.json）恰好是唯一能让 C2/C6 达到设计所需的形态——结论对，但文档没写出"为什么必须原生"的硬理由（CC 方言无 updatedInput、无父会话 id），现在有了。

---

*审查证据基线：DSH 0.1.5-rc.3（`C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\`）；opencode-worktree-isolation 本地源码；zcode-worktree-plugin 本地源码（含 204 用例测试）；opencode-worktree-guard@0.3.7 npm tarball。*
