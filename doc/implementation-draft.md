# dsh-worktree-guard 实现方案（v0.2 草案）

> **依据**: [design.md](design.md)（v0.1）+ [design-review.md](design-review.md)（宿主契约实测）。本文把三层防御逐层落到已验证的 DSH 机制上，给出可开工的组件划分、代码形态与 M0 清单。
> **核心结论回顾**: DSH 不允许钩子改写工具入参（`updatedInput` 不生效、`exec.arguments` 深冻结），但 (a) `tools/pre-execute` 拦截 deny 白送；(b) **`ctx.fs` 是可子类化替换的服务后端**（`dsh-fs-sandbox` 的 `SandboxedFileSystem extends LocalFileSystem` 即官方先例），而 read/write/edit 全走 `ctx.fs.resolve → writeText/editText`（`dsh-tool-fs/lib/index.js:273,649,798`）——**重写做在 fs 层，拦截做在工具层**，这是本方案与两位前辈的根本差异。

---

## 1. 总体形态

**一个原生 cordis 插件 npm 包**（不用 hooks.json——CC 方言无 updatedInput、无父会话 id、命令钩子 fail-open）：

```
dsh-worktree-guard/
  package.json          # name + "dsh": { bundle: { patch: "cordis.patch.yml" } }
  cordis.patch.yml      # 引入插件本体
  src/
    index.ts            # apply(ctx, config)：组装下列四个部件
    guard.ts            # 部件A：tools/pre-execute 常开安全网（deny-only）
    fs-backend.ts       # 部件B：WorktreeFileSystem（ctx.fs 重写缝）
    wt-tools.ts         # 部件C：worktree_* 自定义工具（tools.register）
    notices.ts          # 部件D：提示注入（session-start / pre-step / post-execute）
    core/               # 纯函数库（无 cordis 依赖，可单测）
      decision.ts       # 决策表（从 zcode 204 用例方法论冻结而来）
      paths.ts          # Windows 归一化（移植 opencode norm()：\\?\ 剥离/大小写/分隔符）
      binding.ts        # 绑定解析三层（own → parentSession 链 → null）
      store.ts          # <git-common-dir>/worktree-guard/ 状态读写（移植 zcode）
      gitops.ts         # merge-base 验证、分支删除、worktree 生命周期
  wt.mjs                # CLI 包装（同一 core，人用/脚本用；零依赖 ESM）
  test/                 # 决策表驱动测试（v2.test.mjs 方法论移植）
```

插件入口遵循宿主包形态（`dsh-tool-todo` 实例）：

```ts
export const name = "worktree-guard";
export const inject = ["tools", "fs"];   // fs 后端替换需要
export const Config = /* schemastery/zod：branch_prefix、protected_branches、link_scan… */;
export function apply(ctx, config) { /* 组装 A–D */ }
```

## 2. 三层防御 → DSH 机制映射

| 层 | v0.1 设想 | v0.2 落地（已验证机制） |
|---|---|---|
| ① 提示 | SessionStart 注入 | `agent/session-start` → `agent.inject`（绑定告知）；`agent/pre-step` 每步低成本重申"已绑定副本 X，相对路径即副本"；`tools/post-execute` additionalContexts 做 `[worktree]` 重写通告（opencode issue #11 的 DSH 等价物） |
| ② 工具 | write/edit/read 路径改写 | **改写下沉到 fs 层**（部件B）；工具层只做 **deny**（部件A）：跨副本写入、写 `.git`、push protected、删 worktree 分支、pwsh 命令文本含主根绝对路径/危险 git 操作 → deny + 指令性错误消息（chuck-ma 风格 block-with-instruction） |
| ③ 沙箱 | 会话根协同 | `create` 完成后引导"以 worktree 为会话根新开会话"（沙箱自动锚定 `SessionHeader.cwd`）；**新增**：监听沙箱模式切换/提权，绑定态下 `danger-full-access` → deny 或强告警 |

## 3. 部件B：WorktreeFileSystem（本方案的关键创新点）

`dsh-fs-sandbox` 证明了"子类化后端再换装"是受支持的组合方式。照此：

```ts
// 优先形态：包裹已挂载后端（避免与 fs-sandbox 二选一）
class WorktreeFileSystem /* wraps ctx.fs */ {
  async resolve(requested, options) {
    const session = options?.actor?.agent?.session;          // tool-fs 逐调用传入 exec
    const binding = resolveBinding(session);                  // 部件core：own → parentSession 链 → null
    if (!binding) return super.resolve(requested, options);   // 默认开放
    const target = normalizeTarget(requested, /* 主根 */);     // paths.ts 归一化
    const action = decidePath(target, binding);               // decision.ts：同 zcode decideWrite 表
    switch (action.kind) {
      case "allow":       return super.resolve(requested, options);
      case "rewrite":     return super.resolve(mapRtoW(target, binding), options);  // R→W
      case "deny":        throw new FsError(action.reason, "WORKTREE_GUARD_DENY");
    }
  }
}
```

为什么这是对的缝：

1. **一处覆盖全部文件工具**：read/write/edit/read_image 都经 `ctx.fs.resolve`（实测 `dsh-tool-fs/lib/index.js:273/649/798`）；glob/grep（`dsh-tool-fs-search`）走同一服务——M0 复验一条即可。
2. **读视图一致性自动达成**（v0.1 目标 3 在工具层不可达、在 fs 层白送）：resolve 是读写共用的第一步。
3. **不对抗冻结参数设计**：决策发生在服务层，工具入参、审计日志、UI 渲染保持模型原话——比 `tools/execute` 重派干净。
4. **fail 语义可控**：resolve 内异常即工具失败（fail-closed）；只读方法（readText/stat）可选择 catch 后按原路径放行（fail-open）——v0.1 §9 的分工具策略在这里实现，而非依赖宿主。

**M0 必验（C1b 细化）**：① 插件能否在 fs-local/fs-sandbox 已挂载后二次提供 `ctx.fs` 并委托原实现（cordis 服务覆盖语义 + 加载顺序）；② 与 `dsh-fs-observation-policy`（read-before-edit）的交互——重写后观察记录的 targetKey 应落在 W 侧，验证无冲突；③ 与 sandbox backend 叠加时的 resolve 顺序（重写必须先于沙箱围栏判断，否则"重写到 W 后仍被主根围栏误拦"）。

## 4. 部件A：常开安全网（deny-only，永远生效）

`ctx.on("tools/pre-execute", (exec, next) => …)` 返回 `{kind:"deny", reason}`（机制实测：waterfall `dsh-tools/lib/index.js:3116`）。规则按 v0.1 §5 冻结，全部为代码常量、优先于配置：

- `write`/`edit`：目标（经归一化）落入其他副本 / `.git` → deny（fs 层已挡，这里是纵深防御——pre-execute 看的是模型原始入参，能捕获"模型显式写了主根绝对路径"并给出更准确的指令）。
- `pwsh`：命令文本检查（移植 zcode 的 GIT_PUSH_PROTECTED_RE / GIT_DEL_WORKTREE_RE / git -C 上下文解析 v0.4.2）；**不做任何改写**；检测到主根绝对路径 → deny + "用相对路径或先 enter"（残余路径检测兜底，诚实边界同 v0.1 §12.1）。
- 绑定态 + 沙箱模式为 `danger-full-access` 或收到提权 → deny（v0.1 没有的 DSH 特有规则）。
- patch 类不可解析载荷的工具（若有）→ 绑定态 deny（学 opencode 对 patch 的处理）。

## 5. 部件C：worktree_* 原生工具

`ctx.tools.register(defineTool({…}))`（形态见 `dsh-tool-todo/lib/index.js:95`）：

```
worktree_create {task_name}      worktree_enter {path}
worktree_exit  {action}          worktree_remove {path, confirm_remove, delete_branch}
worktree_prune {dry_run?}        worktree_status {}
worktree_authorize_main {reason, ttl_minutes?}   worktree_revoke_main {}
worktree_allow {action, path, reason, ttl_minutes?}
```

- 全部是 `core/` 纯函数的薄壳；`wt.mjs` CLI 复用同一 core（人用通道，参数与 zcode 对齐）。
- `enter` 写 `bindings/<session_id>.json`（session id 取 `exec.agent.session.header.id`）；子代理不重复 enter——`resolveBinding` 惰性走 `parentSession` 链快照（`dsh-subagent/lib/index.js:502-508` 实证 header 自带父 id，**不需要 zcode 的 SQLite 父链**），继承绑定永不阻塞 owner（never-block-owner 不变量沿用）。
- `status` 输出标注 rooted / repo-rooted 模式；`remove` 前的 merge-base `--is-ancestor` 验证与 link_scan "all" 全树摘链接，均从 zcode/chuck-ma 移植。
- 会话标题 `🌿 <branch>`（`dsh-session-title` 体系，低成本可见性，opencode 先例）。
- 附带红利：`create` 时在 worktree 内放 `.dsh/skills/worktree-cleanup/SKILL.md`——项目级技能自动发现（`dsh-skill-filesystem/lib/index.js:155-177` 实证），副本自带收尾清单，主 checkout 零污染。

## 6. 部件D：提示注入

| 时机 | 机制 | 内容 |
|---|---|---|
| 会话启动 | `agent/session-start` → inject | 有绑定：告知副本路径/分支/模式；无绑定但有 stale state：提示 |
| 每步 | `agent/pre-step`（append 到进入批次） | 绑定态一行纪律："已绑定 <W>，写文件用相对路径" |
| 工具后 | `tools/post-execute` additionalContexts | 本会话发生过 fs 重写时附 `[worktree] R→W` 通告（防误归因） |

不碰稳定系统提示（对齐 `dsh-sandbox-policy` 的常驻段模式，保护 KV cache）。

## 7. 状态存储（沿用 zcode，不变）

`<git-common-dir>/worktree-guard/{bindings/<sid>.json, state.json, allowlist.json, bases.json, audit.jsonl, meta.json}`；绑定只来自本会话 enter；死绑定经静默超阈 + status stale + prune 回收（DSH 无会话结束回调，`agent/disposed` 事件 M0 验证能否替代）。

## 8. 更新后的 M0 spike 清单

| # | 验证项 | 已有证据 | 待实测 |
|---|---|---|---|
| C1a | tools/pre-execute 拦截 + deny | ✅ 已实证（本审查） | 冒烟固化 |
| C1b | ctx.fs 二次提供/包裹已挂载后端 | 先例：fs-sandbox 子类换装 | 覆盖语义、加载顺序、与 observation-policy/sandbox 叠加 |
| C2/C5 | 载荷与注入点 | ✅ 已实证 | — |
| C3 | —（已关闭：改写不可行，事实保留在 §4 pwsh 行为 deny-only） | ✅ | — |
| C4 | tools.register + defineTool | ✅（dsh-tool-todo 实例） | 冒烟 |
| C6 | parentSession 继承 | ✅ header 实证 | subagent 冒烟：子会话 resolve 拿到父绑定 |
| C7 | fail 语义 | ✅（native throw=fail-closed） | — |
| C8（新） | `agent/disposed` 能否做绑定回收回调 | 未验 | 实测 |
| C9（新） | 沙箱模式切换的事件可监听性（`sandbox/mode` 是 log-only 事件，guard 能否读到） | 未验 | 实测 |

## 9. 里程碑（修订）

- **M0**：上表 C1b/C8/C9 三项实测 + 《宿主契约证据》定稿。**若 C1b 失败**：降级为纯部件A+C+D（deny 式 + 会话根模式主推），设计的 repo-rooted 透明重写整体后置，并推动上游 honor `updatedInput`。
- **M1**：部件A（安全网）+ 部件C（create/enter/exit/status）+ 部件D + 会话根模式引导。**不含 fs 后端**——M1 在无重写下即安全可用（deny+指令），风险最低路径先行。
- **M2**：部件B（fs 重写缝）+ 子代理继承 + authorize/allow + prune + merge-base。
- **M3（可选）**：客户端侧栏（`dsh` manifest 的 client 入口，`wt status --json` 数据源，参考 zcode-executor 面板）。

## 10. 风险与诚实边界（增量）

1. C1b 是本方案唯一未实证的承重假设——M1 刻意不依赖它。
2. fs 后端包裹与未来上游 fs 变更耦合（回填：钩子契约回归测试，宿主升级一键复验）。
3. pwsh 命令文本检查的绕过面与前辈一致（复合命令、8.3 短名）——-raising the bar 定位不变。
4. 审计含绝对路径（沿用 zcode 的手工脱敏约定）。
