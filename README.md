# dsh-worktree-guard

可选的 git worktree 守卫 DSH（DeepSeek Harness）插件。

> **宗旨**：把 worktree 从"模型的自觉"变成"宿主的结构"——隔离靠会话根（结构），安全靠单调收窄的常开网（兜底），授权靠带 TTL 的机械人闸（治理）。

完整设计（含宿主契约证据、七条裁决性原则、决策表、Agent 沟通面）见 [doc/design.md](doc/design.md) v1.1。

## 它做什么

- **会话根模式（产品本体）**：`worktree_create` 建副本后，以副本为会话根新开会话 → DSH 沙箱自动锚定，写隔离即结构。
- **常开安全网**（是否绑定都生效）：跨副本写入、写 `.git`/状态区、push 受保护分支（master/main）、删 worktree 分支、`git -C` 定向到主根 → deny + 单轮可执行的指令。
- **读域守卫**：绑定态读主 checkout → 放行 + 溯源标记（默认 warn）或 deny（strict）——防止"写对地方、改错东西"。
- **机械人闸**：`worktree_authorize_main`/`worktree_allow` 走 pre-execute ask 门，模型无法自授。
- **收尾零债**：merge-base 证明式"已合并"判定、死绑定 prune、全树摘链接后再删副本（防 junction 穿透）。

## 守卫等级（诚实分级，P6）

| 等级 | 覆盖 |
|---|---|
| 结构拒绝 | 会话根沙箱写隔离；authorize ask 门 |
| 词法启发 | pwsh 命令文本、路径归一化判域、读域守卫（8.3 短名/变量拼接可绕——raise the bar，非边界） |
| 纯纪律 | danger-full-access 下的一切 |

已知边界详见 [doc/design.md §14](doc/design.md)。

## 安装与使用

DSH 插件（package.json `dsh.bundle.patch` → [cordis.patch.yml](cordis.patch.yml)），加入 profile 组合加载。

```bash
# CLI（与原生工具同一 core）
node wt.mjs create fix-login --brief "修复登录"
node wt.mjs status
```

会话内（插件加载后）使用 `worktree_create` / `worktree_enter` / `worktree_exit` / `worktree_status` 等工具；被拦截时按 deny 消息的"下一步"行动，或调用 `worktree_status`。

配置 sidecar：`<repo>/.dsh/worktree-guard.json`（`protected_branches`、`read_policy`、`sync.*` 等，见设计 §13）。

## 开发

```bash
node --test   # 决策表单测 + 真实临时仓库集成测 + 三轮对抗审查回归（见 test/）
```

零依赖纯 ESM（Node ≥20，Windows 优先适配）。

## 谱系

opencode-worktree-isolation（透明重写、Windows 归一化）× zcode-worktree-guard（默认开放、常开网、prune、204 用例方法论）× chuck-ma opencode-worktree-guard（merge-base、block-with-instruction）→ 按 DSH 实测契约（不可改写入参）重构为结构优先形态。详见 [doc/design-review.md](doc/design-review.md)。
