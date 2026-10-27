# dsh-worktree-guard 设计文档

> **状态**: v1.2（round-13 实测修订；实现已发布于 0.2.x，见 [TEST-REPORT](../TEST-REPORT.md)）
> **谱系**: `opencode-worktree-isolation`（透明重写、Windows 归一化、[worktree] 通告）× `zcode-worktree-guard`（默认开放、常开安全网、authorize-main、prune、204 用例方法论）× `chuck-ma opencode-worktree-guard`（merge-base 验证、block-with-instruction）→ DSH 原生形态移植与进化
> **修订史**: v0.1（契约假设待验）→ 宿主契约实测（C1–C7，[design-review.md](design-review.md)）→ v0.2 实现草案（[implementation-draft.md](implementation-draft.md)）→ 四路对抗审查（[design-tenets.md](design-tenets.md)）→ v1.0（重写路线击穿，重心翻转为会话根）→ v1.1（补读域守卫 + Agent 沟通面 + 不侵入原则，全面梳理）→ **round-13（issue #1：审批禁用会话的 ask 死路、CLI 人证升级为键入随机确认码、authorize 词法网误报修复；C11 审批策略探测）**
> **方法论**: 契约证据先行 + 对抗审查定稿。两次关键纠偏均由实证驱动：① 重写路线被宿主源码三连击穿（cordis 服务不可包裹 / glob·grep 旁路 ctx.fs / resolve 无会话身份）；② "读无害"结论从 zcode 移植时丢失前提（zcode 的 read 是被重写回副本的），补读域守卫。

---

## 0. 定位与宗旨

> **把 worktree 从"模型的自觉"变成"宿主的结构"：隔离靠会话根（结构），安全靠单调收窄的常开网（兜底），授权靠带 TTL 的机械人闸（治理）。**

可选的 git worktree 守卫 DSH 插件。**会话根模式（rooted）是产品本体**：`worktree_create` 引导以副本为会话根新开会话，DSH 沙箱自动锚定 `SessionHeader.cwd` → 写隔离即结构；插件负责沙箱不管的一切——**push 主干、删 worktree 分支、写 `.git`、合并验证、死绑定盘点、链接穿透安全删除**，以及沙箱不管的**读位置正确性**（读域守卫，§6.1）；沙箱切到 danger-full-access 的那一刻，插件是唯一的网。

与 v0.1 的根本差异：v0.1 以"写路径透明重写"为灵魂；DSH 实测证明钩子不能改写工具入参（`updatedInput` 不生效、`exec.arguments` 深冻结、cordis fs 服务不可包裹），透明重写在本宿主接近不可实现。设计重心翻转为：**结构（会话根）优先于重写，重写降级为上游依赖的实验特性（§17）**。

## 1. 七条裁决性原则

设计争议逐条对照裁决：

- **P1 单调收窄**：守卫只能比宿主沙箱更严，永不更宽；allowlist/authorize 不得放行宿主本会拒绝的路径。"默认开放"的准确含义是"未绑定 = 退化为宿主沙箱语义"。
- **P2 结构优先于重写**：凡能靠会话根/沙箱结构解决的，不写路径变换。重写是最后手段、仅限路径解析语义（永不扩展到 content/command 文本），且当前依赖上游能力（§17）。
- **P3 偏离必可见**：任何偏离模型原话/预期世界的执行效果或结果，必须在返回模型的上下文留痕——涵盖未来的重写通告与现在的读域溯源标记。
- **P4 人闸必须机械**：授权操作必须经 `ask_user_question` 阻塞式真人确认（TTL 自确认时刻起算、审计记录应答），不接受提示词软约束——显式修复 zcode 已知弱点（其 authorize-main 为 agent 自调自授）。
- **P5 never-block-owner**：会话对自身绑定的解除与收尾，永不被自己或死会话阻塞。
- **P6 诚实降级**：每条守卫标注等级——**结构拒绝**（沙箱/会话根/ask 门）/ **运行期挑战**（CLI 一次性确认码：机械校验，非结构边界、非身份认证；能控制该终端并读回显示码的自动化可重放）/ **词法启发**（pwsh 文本、路径归一化、读域判域）/ **纯纪律**（提示层）。README、deny 消息、文档同词汇。danger-full-access 下的一切 = 纯纪律级（含任意脚本内容与直接写状态文件）。
- **P7 零侵入**：插件不读写用户的 `AGENTS.md`/`CLAUDE.md` 及任何用户文档；一切 Agent 沟通经会话注入通道与工具 schema，会话结束即消失；副本内仅新增 DSH 配置空间自有文件（`.dsh/`），随副本清理消失。

**P6 推论（沟通面即防线）**：结构级正确无需模型配合；**词法级正确的最后一段防线就是 deny/标记消息本身**——消息必须自足、单轮可执行（§7）。

## 2. 目标与非目标

### 目标

1. **写位置正确**——会话根模式为主解：主根在 workspace root 之外，越界写被沙箱**结构拒绝**。
2. **读位置正确**——相对路径读天然落副本（结构默认）+ 读域守卫（词法）：绑定态读主根 → 溯源标记或 deny（§6.1）。"写对地方"与"改对东西"缺一不可。
3. **误毁主分支常开兜底**——push master/main、写 `.git`/git-common-dir、删 worktree 分支，任何时候拦截（词法级，deny 消息即防线）。
4. **合并回主干的人机权限边界**——authorize-main：机械人闸（ask 门）+ TTL + 审计。
5. **收尾零债**——merge-base 显式验证（`--is-ancestor`）+ status 盘点 + 死绑定 prune + 链接穿透安全删除。
6. **状态常显**——常驻状态行 + 🌿 会话标题 + deny 前缀（误用防范 90% 靠状态可见）。

### 非目标

- ~~读视图一致性（v0.1 目标 3）~~：会话根模式下相对路径自动成立；绝对路径读域靠守卫（warn/deny），不再是"重写保证"。
- repo-rooted 模式的透明重写——依赖上游（§17），非本插件承诺。
- 不做规划/执行分离；不替代 DSH 沙箱（P1）；不追求对任意 shell 重定向/变量拼接的完美拦截（P6 如实标注，§14）。

## 3. 宿主契约证据摘要

DSH 的机制事实（全部源码实证，`C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\`，详见 [design-review.md](design-review.md) 与对抗审查）：

| 事实 | 判定 | 对设计的意义 |
|---|---|---|
| `tools/pre-execute` 拦截 + allow/ask/deny | ✅ | 安全网与 ask 人闸的落点 |
| 钩子改写工具入参（`updatedInput` / 深冻结 args） | ❌ | 重写不可行 → 结构优先（P2） |
| cordis fs 服务不可包裹、glob/grep 旁路 ctx.fs、resolve 无会话身份 | ❌（三连） | fs 层重写整体出局 |
| 沙箱以 `SessionHeader.cwd` 为 workspaceRoot，只围栏 write/edit | ✅ | 写正确=结构；**读无围栏** → 读域守卫 |
| `agent/session-start`/`agent/pre-step`/`tools/post-execute` 注入点；不改写稳定系统提示 | ✅ | 沟通面五通道（§7，P7） |
| `tools.register(defineTool)`；项目 `.dsh/skills` 自动发现 | ✅ | worktree_* 工具 + 副本自带收尾技能 |
| header 自带 `parentSession` | ✅ | 子代理继承无需 DB |
| 原生插件 throw = fail-closed | ✅ | fail 语义白送 |
| `agent/disposed`（C8） | ✅ | Event 目录实证（emit，payload `{agent}`）；round-8 落地：disposed 时为本会话绑定盖 `resolved_at`（不删——resume 友好，prune 终删） |
| 沙箱模式可监听（C9） | ✅ | `ctx.fs.sandboxMode` / `ctx.sandboxPolicy.resolve` 能力探测已实现（R5-2 回归） |
| 审批策略可探测（C11） | ✅ | `ctx.get("approval")` → `overrideOf(session)` / `config.policy`；策略 `never` 的会话 ask 必被宿主自动拒绝（无弹窗，文案仍是 `the user rejected tool`）——round-13 据此把必败 ask 改为带人工通道指引的 deny（§11）；post-execute 对 gated 工具被拒按重探测策略补标记；主分支授权收敛为 `core/authorize.js` 单一路径（confirm 回调注入），CLI 人证=键入本次随机确认码（§11） |
| 编程式以指定 cwd 建会话（C10） | ⚠️ 能力面已实证 | Service 目录见 `agentLoop.create(id, options, meta: Pick<SessionHeader,'cwd'>)` 与 `workspaceController.create`；实际调用冒烟仍未做，rooted 引导文案为当前形态 |
| 宿主多可写根 / 原生 worktree 子系统 | ❌ 不存在 | rooted 是唯一结构路径 |

## 4. 架构

```
┌────────────────────────────────────────────────────────┐
│ 产品本体：会话根模式（rooted）                            │
│  worktree_create →（C10 编程式 / 引导式）以副本为根新会话   │
│  + .dsh/task-brief.md 任务交接 + .dsh/skills 收尾技能     │
│  → 沙箱锚定 SessionHeader.cwd，写隔离即结构（P2）          │
├────────────────────────────────────────────────────────┤
│ 常开安全网（部件A：tools/pre-execute，deny-only，永开）     │
│  pwsh 文本：push protected / 删 worktree 分支 / git -C    │
│  绑定态 + danger-full-access / 提权 → deny（C9）          │
│  路径归属判断自带 realpath 归一化（词法，纵深非边界）        │
├────────────────────────────────────────────────────────┤
│ 读写域守卫（部件A'：读侧，§6.1）                           │
│  绑定态 read/glob/grep 命中主根 → warn 标记 / strict deny  │
├────────────────────────────────────────────────────────┤
│ 生命周期（部件C：worktree_* 原生工具 + wt.js CLI）        │
│  M1: create/enter/exit/status                            │
│  M2: remove/prune/authorize_main/allow（ask_user 人闸）   │
├────────────────────────────────────────────────────────┤
│ 沟通面（部件D：五通道，§7）——词法守卫的防线本体（P6 推论）   │
└────────────────────────────────────────────────────────┘
形态：原生 cordis 插件（package.json `dsh.bundle.patch`），不用
hooks.json（无 updatedInput、无父会话 id、命令钩子 fail-open）
```

重写后端（原部件B）已随契约击穿移除，残存形态见 §17。

## 5. 目录结构（实现物）

```
dsh-worktree-guard/
  package.json / cordis.patch.yml
  src/
    index.js        # apply(ctx, config)：组装 A/A'/C/D
    guard.js        # 部件A/A'：pre-execute 安全网 + 读域守卫 + gated 工具策略探测
    wt-tools.js     # 部件C：worktree_* 工具（defineTool）
    notices.js      # 部件D：注入与标记
    core/           # 无 cordis 依赖库（可单测；含 store/gitops/authorize 等 IO helper）
      decision.js   # 决策表（zcode 204 用例方法论冻结）
      authorize.js  # 主分支授权单一路径（TTL 钳制 + 审计 + 确认回调注入）
      human-gate.js # CLI 键入式人证（TTY ≠ 结构，确认码才是）
      cli-path.js   # 由模块位置解析 CLI 绝对路径（deny/ask 文案单轮可执行）
      paths.js      # Windows 归一化（opencode norm() 移植）
      binding.js    # 绑定三层解析
      store.js      # <git-common-dir>/worktree-guard/ 读写
      gitops.js     # merge-base / 分支 / worktree 生命周期
  wt.js            # CLI 包装（同一 core，人/脚本入口）
  test/
```

## 6. 工具覆盖决策表

DSH 工具面（以会话实际暴露为准）。**绑定态 = 会话有绑定（自身或父链继承）**。每行标注 P6 等级。

| 工具 | 路径字段 | 绑定态行为 | 未绑定行为 | 等级 |
|---|---|---|---|---|
| `write`/`edit` | `file_path` | 归一化后落入其他副本（**常开**，未绑定亦拦）/ `.git` / git-common-dir `/worktree-guard/` 状态区 / 主根的 `.dsh/worktree-guard.json` 安全配置 → **deny + 指令**；主根路径 → deny + "以副本为根开会话"（rooted 下通常已被沙箱先拒，此处纵深） | 放行（宿主沙箱语义；跨副本/`.git`/安全配置除外） | 词法启发（纵深） |
| `read`/`read_image` | `file_path` | **读域守卫（§6.1）**：命中主根 → 默认 warn 放行 + 溯源标记；`read_policy:"strict"` → deny + 指令；其他副本 / `.git` 读放行（排障） | 放行 | 词法启发 |
| `glob`/`grep` | `path` | 同 read 读域守卫（缺省 path 天然落副本，结构默认） | 放行 | 词法启发 |
| `pwsh` | `command` | 文本检查：`push`→protected、`branch -D worktree-*`、`git -C <主根>`、主根绝对路径残余 → **deny + 指令** | 同规则常开（安全网部分） | 词法启发 |
| 后台 job / subagent / workflow | — | 同一 pre-execute 覆盖（C6）；workflow 内联脚本无 fs API（实测）；MCP 写盘不在范围（§14） | — | — |
| `worktree_authorize_main` / `worktree_allow` | — | **pre-execute 返回 `{kind:"ask"}`**（P4 机械人闸）；审批策略 `never` 的会话没有应答者，宿主必自动拒绝 → 直接 **deny + 人工通道指令**（round-13，§11） | 同 | 结构（ask）/ 运行期拒绝（never） |

决策表冻结后每行至少一组测试用例（§15）。

### 6.1 读域守卫（read-domain guard）

**问题**：写位置正确性由会话根结构保证，但**读位置正确性没有**——DSH fs 沙箱只围栏 write/edit，read 全放行；绑定态下模型用主根绝对路径 read/glob/grep 会静默读到主干旧世界，基于错误理解改副本：**写对地方、改错东西**，且读结果无来源标注、模型无法自察。

**机制**（pre-execute 判域 + post-execute 留痕）：

- 判域与 write 行同源：归一化目标 vs 主根/兄弟副本前缀（词法启发级）。
- **默认 `warn`**：放行 + §7 通道 5 溯源标记——保留排障自由（对比副本差异、查 `.git`），消除静默误读（P3）。
- **`strict`（可配 `read_policy`）**：主根读直接 deny + "你在副本 <W> 中，用解析到本副本内的路径"——读重试廉价、一步终止，可用性代价可控；兄弟副本与 `.git` 读仍放行。
- `enter` 提示与常驻状态行列明"当前读域基准 = 副本"。

> 谱系注记：zcode v0.4.1 "读无害"结论的前提是其 read 被重写回副本（其 A09 用例：Read main → rewrite）——允许跨副本读是给排障的自由，而主根读根本到不了主根。本设计无重写能力，移植该结论必须补读域判断，否则"读无害"退化为"读哪都无害"。

## 7. Agent 沟通面（五通道；词法守卫的防线本体）

模型看不到插件文档与 README——它只能看到：工具 schema 描述、注入上下文、deny 消息、标记。注入文本随上下文重发直至压缩 → **常驻内容极短、一次性内容可详**。**P7 零侵入**：不碰用户任何文档文件；DSH 不鼓励改写稳定系统提示（KV cache），`agent.inject` + 常驻段是受认可等价机制。

| 通道 | 机制 | 时机 | 预算 |
|---|---|---|---|
| 1 工具描述 | `defineTool` description（进 schema，永远可见） | 静态 | ≤120 词/工具 |
| 2 常驻状态行 | 常驻段（`dsh-sandbox-policy` 同款） | 每请求 | **1 行** |
| 3 Session-start inject | `agent/session-start` → `agent.inject` | 会话建立时 | ≤15 行 |
| 4 deny/ask 消息 | pre-execute reason | 拦截时 | **3 行模板**；第 3 行保持简短，授权工具细节放该工具的 deny/post-execute 标记（round-13：push deny 用简版提示，避免每次重复 ~300 字符条件句） |
| 5 post-execute 标记 | additionalContexts（读域溯源 / 重写通告 / gated 工具被拒归因） | 事件时 | 1 行 |

### 文案契约（冻结为实现验收标准）

**通道 2**（绑定态才有；未绑定零注入）：

```
[worktree-guard] 本会话锚定 worktree 副本 <basename>（分支 <branch>）。读写均以本目录为基准；
主 checkout 与其他副本的路径会被拦截/标注。
```

**通道 3**（仅在有信息量时注入）：

- ① rooted 副本会话（检测到绑定）：

```
[worktree-guard] 本会话根是 worktree 副本（分支 <branch>；主 checkout 与其他副本勿写）。
守则：读写路径必须解析到本副本内（本目录即根）；合并/push 主干须经用户授权工具，不要直接 git push/checkout 主干。
任务背景：见 .dsh/task-brief.md。收尾：worktree_status（合并证明+清理步骤）→ 用户同意后 worktree_authorize_main 合并回主干 → worktree_exit remove 清理 → 完成。
```

- ② 主根会话 + stale 绑定：提示"上会话副本未收尾，调 worktree_status 盘点并报告用户清理建议"。
- ③ 干净状态：**零注入**（P1 不加噪音）。

**通道 4 — deny 三段式**（拦了什么 / 为什么 / 下一步精确动作）：

```
[worktree-guard] 已阻止 <write/pwsh …>：<目标/命令摘要>。
原因：<落入主 checkout|其他副本|.git|push 受保护分支|…>（效果导向措辞，不出现检测维度）。
下一步：<精确替代动作>。例：用解析到本副本内的路径写入；或调用 worktree_status 查看当前绑定。
```

**通道 5 — 读域标记**（§6.1 warn）：

```
[worktree-guard] 该读取来自主 checkout（非绑定副本）——内容是主干世界，勿据其判断副本代码现状。
```

**通道 1 — 工具描述三要素**（何时调/何时不调/调后发生什么）：

- `worktree_create`：建完副本后**应以副本为根新开会话**（返回体附引导/触发）；task 描述存入副本 `.dsh/task-brief.md` 供新会话恢复背景。
- `worktree_status`：定位为"**被拦截后的第一求助对象**"——所有 deny 消息显式指名调用它。
- `worktree_authorize_main`：明示"**需要用户在界面上确认，模型无法自行通过**；请在用户明确同意后才调用，重复调用会被再次询问"（P4 的沟通面落地）。
- `worktree_allow`：同上 + TTL 语义。

**文案规则**：① **自足**——模型在第 300 轮忘掉一切提示时，单凭 deny 消息即可改对（常驻行降首次犯错率，deny 兜底再教育）；② **单轮终止**——"下一步"必须是立刻可执行动作，不得是"请阅读文档"；③ **不泄防御细节**——词法匹配规则不写入消息，只给正确路径。

### 读写正确性的沟通面覆盖核对

| 正确性目标 | 守卫 | 沟通面配合 |
|---|---|---|
| 写落副本 | 结构（沙箱） | 常驻行降犯错率；越界 deny（通道4）兜底 |
| 不误毁 git 层 | 词法（pwsh 文本） | deny 三段式 = 防线本体 |
| 读落副本 | 结构默认（cwd）+ 词法守卫 | warn 标记（通道5）/ strict deny；常驻行写明"读基准=本目录" |
| 授权不越权 | 结构（ask 门） | 工具描述预告"用户会收到询问" |
| 收尾零债 | 生命周期工具 | Session-start 守则（通道3）+ status 指路 |

## 8. 生命周期与命令

部件C：`ctx.tools.register(defineTool(...))` 原生工具（模型入口）+ `wt.js` CLI（同一 core 纯函数库，人/脚本入口，与 zcode 参数对齐）。

```
M1: create {task_name}      # .worktrees/worktree-<slug> + 分支 + sync 复制/junction
    #   + .dsh/task-brief.md + .dsh/skills/worktree-cleanup/SKILL.md（DSH 配置空间自有文件，P7）
    #   + C10: 引导/触发以副本为根的新会话
    enter {path}            # 仅 rooted 会话有效；repo-rooted 会话 → 拒绝并引导
    exit {action}           # 解绑；remove 联动清理
    status {}               # 绑定/模式/已合并可清理（merge-base 证明式）/孤儿目录/stale
M2: remove {path, confirm_remove, delete_branch}
    prune {dry_run?}        # 死绑定回收（C8 或静默超阈）
    authorize_main {reason, ttl_minutes?}   # ask_user 人闸；TTL 默认 15min
    revoke_main {}
    allow {action, path, reason, ttl_minutes?}  # 同走人闸；默认 60min
```

约定：task_name 小写 slug；`git branch -d` 只删已合并分支；status 用 `git merge-base --is-ancestor` 把"已合并可清理"变成证明；never-block-owner（P5）。

## 9. 状态存储与审计

```
<git-common-dir>/worktree-guard/
  bindings/<session_id>.json   # 绑定真值（仅本会话 enter 写入）
  state.json                   # 最近活动记录（不产生绑定）+ 全局授权 TTL 载体
  allowlist.json / bases.json / meta.json
```

- 绑定只来自本会话 enter；state.json 不锁新会话。
- **审计**：`audit.jsonl`（含绝对路径，分享前手工脱敏）为主副本；会话侧的持久留痕依赖宿主记录 pre-execute deny 的 reason（消息文本进入会话转录）——不假设额外宿主 API（诚实边界：jsonl 在 danger-full-access 下可被绕过词法网者篡改，属 §14.3 已声明边界）。round-13 起 deny/ask 文案会内嵌**本机插件 CLI 的绝对路径**（否则 profile 安装的用户拿不到可执行命令）；会话转录分享前同样脱敏。
- 状态区整体 deny 模型写入（write 工具 + shell 词法网双面，仅 wt 工具进程外写）——防自授/防篡改；仓库级**安全配置**（`.dsh/worktree-guard.json`）同样 deny 模型写入，由用户直接编辑（round-13）。

## 10. 子代理继承

`resolveBinding` 三层：① 自身 bindings 文件；② 惰性沿 `exec.agent.session.header.parentSession` 链快照（深度上限 10）；③ null → 开放。继承绑定永不阻塞 owner（P5）；父会话结束由 C8 回调或 prune 级联。无需任何 DB。

## 11. 安全模型

- **硬规则为代码常量**：`.git`/git-common-dir 写、跨副本写、删 worktree 分支、状态区写、安全配置写——不因配置/白名单放宽；push 受保护分支的**集合**可由 `protected_branches` 配置**只增不减**（默认 master/main 始终在内，P1：push 是网络操作，删除保护等于关掉唯一防线）。
- **fail 策略**：原生插件 throw 即 fail-closed（宿主白送）；只读路径判断自身 catch 后放行（fail-open）；全局开关回退全 fail-open。不提供 hooks.json 形态（命令钩子 fail-open 语义混杂）。
- **人闸**：authorize/allow 默认走 `ask_user_question`（P4）。**审批策略 `never` 的会话没有应答者**：宿主在弹出确认框之前就把 ask 判为拒绝（模型看到 `the user rejected tool`，非用户反悔）。round-13 起 pre-execute 探测 `approval.overrideOf(session) ?? config.policy`，命中 `never` 直接 deny 并给出人工通道（用户手动 push/合并、用户终端运行插件 CLI、切换会弹确认的预设），post-execute 按重探测的策略对仍被拒的 gated 工具补一行归因标记；CLI 授权是**仓库级 TTL**（`state.json`，全部会话/关联 worktree 生效），README 明示。**CLI 的 TTY 检查是启发而非边界**：程序化新建控制台（`Start-Process`/`conhost`/python `CREATE_NEW_CONSOLE`）同样 `isTTY=true`，因此 `authorize-main` 要求**键入本次显示的随机确认码**（60s 超时、未确认不落授权）。**等级诚实（P6）**：这是"运行期挑战-应答"，只证明有实体在该终端读码并键入；能读取控制台缓冲并注入输入的程序可重放——那已属任意代码执行（§14.3），而非本门能防的层级。结构级人闸仍只有宿主 ask 门；词法网对字面动词保持 fail-closed（仅纯只读检查链放行，见 §14.1）。
- **沙箱联动**（C9，防御式实现）：宿主暴露 `ctx.fs.sandboxMode` / `ctx.sandboxPolicy.resolve` 时，绑定态 + danger-full-access → deny + 告警（worktree_* 生命周期工具豁免——P5 逃生口不可自堵）；能力缺失则无操作（P1 不假设宿主形态）。
- **allowlist 防注入**：`.git`、裸根、`*` 拒绝；路径校验。

## 12. Windows 适配

- 大小写不敏感 + 分隔符归一 + `\\?\` 前缀剥除（opencode `norm()` 移植）；realpath canonical identity 判路径归属。
- `symlink_dirs` 用 junction；清理副本前全树 lstat+unlink 摘除全部链接（含手工未声明者，`link_scan: "all"` 默认）——防 `git worktree remove` 递归穿透。
- fsmonitor 多 worktree IPC 噪音过滤；DSH Windows 沙箱为 ACL 型（`dsh-sandbox-windows-acl`），拒绝输出适配。

## 13. 配置

`<repo>/.dsh/worktree-guard.json`（sidecar，P7：DSH 配置空间）。**以主 checkout 根为基准解析**（rooted 会话的 cwd 是副本，其 `.dsh` 无 sidecar）；snake_case 与 camelCase 键均接受。已实现字段：`branch_prefix` / `worktree_parent` / `protected_branches`（默认 master,main；**只增不减**，P1）/ `read_policy`（warn|strict）/ `main_write_whitelist`（glob，仓库相对，经 P1 检查后放行主根写）/ `sync.copy_files` + `sync.symlink_dirs` / `allowlist_ttl_minutes` / `authorize_ttl_minutes`（tool 与 CLI 都作为默认 TTL 读取）。~~`strict_git_ops`~~ 已移除：安全网常开是 P1 语义，提供开关等于允许放宽。**该文件由用户维护**：模型的 `write`/`edit` 对它一律 deny（shell 直写仍属 §14 词法边界；`protected_branches` 本身只增不减，改配置无法关掉 push 网/白名单自授）；需要放行时走 `worktree_allow` / `worktree_authorize_main` 人工门。插件级配置走 cordis Config（schemastery）。`protected_branches` 只增不减；其余键（`read_policy`/`branch_prefix`/TTL/同步等）仍为 sidecar（用户）优先于插件默认。

## 14. 已知边界（P6 分级词汇，写进 README）

1. pwsh 文本检查：8.3 短名、`$env:`/`Resolve-Path`/`FileSystem::` 拼路径可绕——**词法启发，非边界**；复合命令的 checkout-protected、`git -C ..` 相对逃逸、`git branch` flag/诱饵变体、push 远程删除、**shell 相对路径写守卫状态区**（`Set-Content ../../.git/worktree-guard/...`、裸目录 `cd .git/worktree-guard` + 相对写、guard 模块 import、authorize 动词）已拦（对抗审查 R1–R3 + round-13 修复）；**嵌套执行器（`cmd /c`、`pwsh -Command`、`iex`）、引号/反引号拼接（`git pus""h`）、子表达式 `$()`、多行脚本、`git config alias`+别名调用经 round-8 归一化 seam 拦截**（`alias` 残余与 env 变量同类，仍属词法边界）；**authorize 字面动词默认整条命令 fail-closed**（raw + 归一化视图都查），唯一例外是**纯只读检查链**（`Select-String`/`grep`/`Get-Content`/`git log…` 等只读段经 `;`/`|`/换行串联，且不含脚本块、命令替换、文件重定向（`2>&1` fd 复制除外）、`Write-Host`/`echo` 等写入型命令、`rg --pre`/`git grep -O…`/`--output` 等内联执行 flag）——round-13 修复"纯读取命令被自授规则误伤"；提交信息/混合命令/变量拼接/别名调用仍拦或属边界（**分段 `cd .git` 再 `cd worktree-guard` 未被拦截，属 §14.3 边界**）；rooted 下 shell 沙箱兜底（写主根=物理拒绝；注意 **push 是网络操作，无沙箱兜底，词法网是唯一防线**），repo-rooted 接不住（故后置）。
2. 读域守卫同属**词法启发**：junction/8.3 别名可绕过判域；strict 误判代价是多余 deny + 重试，不是错误放行——方向安全。
3. danger-full-access 下的一切守卫 = **纯纪律级**：任意脚本内容不受检、可直接写状态文件/配置（故 sidecar 写被词法网拦，但脚本内容仍属此边界）。
4. MCP 工具/第三方进程写盘不在范围——靠纪律 + 会话根对冲。
5. 部署若挂 `dsh-pwsh-local`（无沙箱执行器）则 shell 无围栏——不假设执行器形态，README 明示。
6. 审计 jsonl 同区可篡改（session 日志双写缓解）。
7. C8/C9/C10 失败的降级路径见 §3——均不改变形态。
8. **CLI 确认码是运行期挑战，非身份/结构边界**：能创建/控制真实 pty 并读取控制台缓冲、注入键盘输入的程序可以重放展示码（与 §14.3 的任意代码执行同级）；结构级人闸仍只有宿主 ask 门。

## 15. 测试策略

- **决策表驱动**：§6 表逐行用例 + 字段形态 + 绑定三层解析 + 白名单/人闸/授权/读域 warn·strict 全交叉（zcode A–R 组方法论，目标 ≥200 用例）。
- **沟通面契约测试**（§7）：deny 三段式齐备（前缀/原因/单轮可执行下一步）；常驻行恒 1 行；未绑定零注入；工具描述三要素；标记不泄露词法匹配规则；**预算断言**（deny 恒 3 行、标记 1 行、工具描述 ≤120 词——round-13）。
- **集成**：真实临时 git 仓库全生命周期（create→rooted 会话→读写拦截与标记→人闸→merge-base→cleanup），状态目录 env 隔离。
- **契约回归冒烟**：§3 全部 ✅/⚠️ 项固化为脚本，DSH 升级一键复验。

## 16. 里程碑

- **M0 收尾**：C4b（工具可见性）/C8/C9/C10 四项冒烟 + 《宿主契约证据》定稿。
- **M1（纯已实证机制，零承重假设）**：部件A 安全网 + 读域守卫（warn）+ create/enter/exit/status + 五通道沟通面 + 🌿 标题 + task-brief 交接 + 仅 rooted。
- **M2**：remove/prune + authorize/allow（ask_user 人闸）+ 子代理继承 + merge-base + `read_policy:"strict"`。
- **M3（可选）**：客户端侧栏（`dsh` manifest client 入口，数据源 `wt status --json`）；🌿 会话标题（需宿主 session-title API，M0 未验证故后置）；repo-rooted 重写后端作为实验性 profile 组合件（`extends LocalFileSystem`，与 fs-sandbox 互斥，明示取舍）。

## 17. 上游依赖（正式 feature request）

按杠杆排序：① CC 钩子协议 honor `updatedInput`（已解析、只差生效——回归 v0.1 原设计的最短路径）；② `ctx.fs.resolve` 传入 actor/session（恢复 fs 层会话级判断）；③ SandboxExecutionPolicy 额外可写根（repo-rooted 下重写需求整体消失）；④ **沙箱读围栏 / 会话视图根**（read/glob/grep 锚定会话根，读域守卫从词法升格为结构拒绝，退化为纯排障通道）。①–③ 任一落地重启 repo-rooted 评估。

## 18. 谱系与致谢

- `F:\workspace_2\opencode-worktree-guard`（opencode-worktree-isolation）：Windows 归一化、[worktree] 可见通告（仅 bash——P3 泛化之）、allowlist/TTL、junction sync。
- `F:\workspace_2\zcode-worktree-plugin`（zcode-worktree-guard）：默认开放哲学、常开安全网、死绑定 prune、never-block-owner、链接穿透防护、204 用例方法论；其 authorize-main 软约束弱点由 P4 修复；其 SQLite 父链被 DSH 原生 `parentSession` 取代；其"读无害"结论的前提（read 被重写回副本）由 §6.1 显式恢复。
- `opencode-worktree-guard`（chuck-ma，npm 0.3.7；真实仓库 `chuck-ma/opencode-config`）：merge-base 解锁验证、block-with-instruction 的 deny 消息风格。其 0.3.5+ postinstall 改写用户配置——**只借鉴设计，不引依赖**（亦为 P7 之戒）。
- zcode-executor 0.5.0：DSH 插件形态先例（`dsh` manifest）。
