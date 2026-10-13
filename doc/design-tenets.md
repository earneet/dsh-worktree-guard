# dsh-worktree-guard 设计宗旨与哲学（对抗审查定稿 v1.0）

> **来源**: 四路对抗审查（宿主契约 / 安全绕过 / 可用性 / 架构哲学）对 [design.md](design.md) v0.1 与 [implementation-draft.md](implementation-draft.md) v0.2 的攻击结果综合。所有"击穿"判定均有 DSH 运行时源码证据（`C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\`）。
> **结论**: 设计宗旨与哲学经对抗检验后**成立且更纯粹**——因为被击穿的部分恰恰都是偏离宗旨的部分。v0.2 的部件B（fs 包裹重写）三连击穿，反而验证了"结构优先于重写"应为第一原则。

---

## 1. 对抗审查改变了什么

### 1.1 被击穿的（v0.2 → 废弃/降级）

| 假设 | 击穿证据 | 处置 |
|---|---|---|
| 部件B"包裹已挂载 ctx.fs" | cordis `provide()` 同名服务二次注册直接 throw（"service fs has been registered"）；`set()` 跨 fiber 亦 throw——一个服务名一个实现，无包裹/委托/叠加 | **废弃**。重写后端仅存形态是 profile 组合件（`extends LocalFileSystem`，与 fs-sandbox 互斥），降级为 M3 实验 + 上游助推 |
| "fs 层一处覆盖全部文件工具" | `dsh-tool-fs-search`（glob/grep）自带 ripgrep 经 `ctx.subprocess` spawn，完全不碰 ctx.fs；pre-execute 又不能改写——glob/grep 的路径重写在 DSH 上两条路全死 | glob/grep 同 pwsh：**deny/放行二选**，无重写 |
| "resolve 能拿到会话身份" | `LocalFileSystem.resolve` 只读 `opts?.cwd`/`opts?.signal`；`sessionResolveOptions` 只构造 `{cwd,signal}`——fs 层无法按会话区分绑定 | 连带证据：repo-rooted 多会话共享 cwd，绑定退化为仓库级——恰是 v0.1 明确拒绝的语义 |
| repo-rooted 模式的 M1 可用性 | 读写结构性分裂（读主根世界、写被逐次 deny），无 chuck-ma 式一步终止循环，也无 zcode 式静默改写 | **M1 只支持会话根模式**；repo-rooted 整体后置并标注"依赖上游" |
| authorize-main 作为模型可调工具 | zcode 原版即无机械人闸（agent 自调自授，仅 SKILL 软约束）——DSH 照搬则"人闸"是装饰 | 改为**体内走 `ask_user_question` 强制人机确认**（DSH 原生），或仅 CLI/面板暴露 |

### 1.2 被守住/加固的

- **部件A（pre-execute deny 安全网）、部件C（worktree_* 工具）、部件D（提示注入）不受任何击穿影响**——M1 路径稳固。
- **会话根模式是唯一结构隔离路径**（宿主无多可写根、无原生 worktree 子系统，均经源码排除）——第③层从"推荐"升为"产品本体"。
- pwsh 文本检查的绕过面（8.3 短名/`Resolve-Path`/`FileSystem::`/变量拼接）与前辈持平；rooted 模式下 shell 沙箱兜底（写主根=workspace root 之外=物理拒绝，`dsh-pwsh-sandbox` 实证）；repo-rooted 下接不住，如实标注。
- 编程式开新会话能力存在（`dsh-api-session-controller` 的 `create`/`openWorkspacePath`）→ 新增 M0 假设 **C10**，配合 `.dsh/task-brief.md` 跨会话任务交接对冲上下文丢失。
- danger-full-access 守卫可实施（`ctx.sandboxPolicy.resolve({session})` / `ctx.fs.sandboxMode`，dsh-tool-fs 同款用法）。

---

## 2. 设计宗旨（一句话）

> **把 worktree 从"模型的自觉"变成"宿主的结构"：隔离靠会话根（结构），安全靠单调收窄的常开网（兜底），授权靠带 TTL 的机械人闸（治理）。**

价值主张（对 DSH 用户）：**DSH 沙箱管"写在哪"，本插件管 git 层误毁与收尾债**——push 主干、删 worktree 分支、写 `.git`、merge-base 合并验证、死绑定盘点、链接穿透安全删除，沙箱一个都不管；且沙箱模式可运行时切到 danger-full-access，**插件是那一刻唯一的网**。

## 3. 六条裁决性原则

未来任何设计争议，逐条对照裁决（同 zcode never-block-owner 的地位）：

- **P1 单调收窄（monotonic tightening）**：守卫只能比宿主更严，永不更宽。allowlist/authorize 不得放行宿主沙箱本会拒绝的路径。"默认开放"在 DSH 语境下的准确含义是"不绑定=退化为宿主沙箱语义"，别无更多。
- **P2 结构优先于重写**：凡能用会话根/沙箱结构解决的，不写路径变换。重写是最后手段、仅限路径解析语义（永不扩展到 content/command 文本改写），且当前依赖上游能力（honor `updatedInput` / resolve 传 actor / 多可写根——已列正式 feature request，作为 repo-rooted 模式的前置依赖）。
- **P3 重写必可见**：任何偏离模型原话的执行效果，必须在返回给模型的上下文留痕（`[worktree]` 通告不变量）。即便部件B 后置，此原则继续裁决一切 post-execute 注入。
- **P4 人闸必须机械**：授权类操作（authorize-main/allow）的"用户同意"必须是机械验证（`ask_user_question` 阻塞等待真人应答、TTL 从人类确认时刻起算、审计记录应答者），不接受提示词软约束。**这是对 zcode 已知弱点的显式修复。**
- **P5 never-block-owner**：会话对自身绑定的解除与收尾，永不被自己或死会话阻塞。
- **P6 诚实降级**：每个守卫断言标注等级——**结构拒绝**（沙箱/会话根）/ **词法启发**（pwsh 文本检查、路径归一化）/ **纯纪律**（提示层）——README、deny 消息、文档使用同一分级词汇。对齐宿主 "containment, not a security boundary" 的诚实传统。danger-full-access 下的一切 = 纯纪律级，明说。

## 4. 定稿架构（v0.3）

```
┌──────────────────────────────────────────────────────┐
│ 产品本体：会话根模式（rooted）                          │
│  create → (C10 编程式/引导式)以 worktree 为根新会话      │
│  + .dsh/task-brief.md 任务交接 + 副本自带收尾技能        │
│  → 沙箱自动锚定副本，隔离即结构                          │
├──────────────────────────────────────────────────────┤
│ 常开安全网（部件A，deny-only，任何模式）                 │
│  pwsh 文本：push protected / 删 worktree 分支 / git -C  │
│  绑定态 + danger-full-access / 提权 → deny              │
│  路径归属判断用自带 realpath 归一化（纵深，非边界）        │
├──────────────────────────────────────────────────────┤
│ 生命周期（部件C：create/enter/exit/status，M1）          │
│  authorize/allow/prune → M2，走 ask_user_question 人闸  │
├──────────────────────────────────────────────────────┤
│ 可见性（部件D，M1）：常驻状态行 + 🌿 会话标题 + deny 前缀 │
└──────────────────────────────────────────────────────┘
  M3（实验，依赖上游）：repo-rooted 重写后端（profile 组合件）
```

审计补强：guard 事件同步写入 DSH session 持久日志（append-only，模型难以篡改），`audit.jsonl` 仅为便利副本。

## 5. M0 清单（收敛后）

| # | 项 | 状态 |
|---|---|---|
| C1a/C2/C4/C5/C6/C7 | 拦截/载荷/工具注册/注入/继承/fail 语义 | ✅ 已实证，冒烟固化 |
| C4b | 插件注册工具对默认 agent 的可见性（ScopedLayers 投影） | 存疑，一条冒烟定案 |
| C8 | `agent/disposed` 做绑定回收回调 | 待实测 |
| C9 | 沙箱模式切换的可监听性 | 待实测（`sandbox/mode` 事件） |
| C10 | 插件调用 `sessionController.create/openWorkspacePath` | 待实测（会话根模式地基） |
| ~~C1b~~ | fs 包裹 | 已击穿，转为上游 feature request 跟踪 |

## 6. 合理性论证（为什么这版站得住）

1. **每条被击穿的假设都在偏离宗旨的方向上**（用重写对抗结构、用软约束冒充人闸、在无会话身份的层做会话级判断）——宗旨不是被审查削弱的，是被审查提纯的。
2. **M1 的每一块都踩在已实证的宿主机制上**（pre-execute deny、tools.register、agent/session-start、沙箱锚定 SessionHeader.cwd），零承重假设。
3. **对前辈的吸收各有裁决**：opencode 的 Windows 归一化与 [worktree] 通告（P3）、zcode 的哲学与 never-block-owner（P5）、chuck-ma 的 merge-base 与 block-with-instruction（deny 消息风格）——同时显式修复 zcode 的授权软约束弱点（P4）。
4. **诚实边界前置**：repo-rooted 的 shell 面、danger-full-access 下的一切，都按 P6 标注"仅纵深/纯纪律"，不冒充边界——这既是安全诚实，也是产品承诺的可验证性。
