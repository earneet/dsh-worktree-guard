# dsh-worktree-guard 安装版冒烟测试（smoke test）

> 目的：`npm test` 驱动的是**仓库源码**；issue #5 证明真正被用户打到的是**已安装副本**（profile `node_modules`），且"工具层 wire 形状参数 → lifecycle camelCase"这条边界曾有零覆盖。本冒烟针对安装副本执行，作为发布/更新后的第一道门禁。
>
> 执行方式：`npm run smoke:installed`（或 `node scripts/smoke-installed.mjs`）。默认目标是 desktop profile 的 `node_modules/dsh-worktree-guard`；用 `WTG_SMOKE_PATH=<路径>` 可冒烟任意安装（如 npm pack 解包目录）。无网络、不需要重启宿主。

## 安装形态（本轮起）

profile 依赖从 registry 版本号改为 `link:`：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dsh-worktree-guard": "link:F:/workspace_2/dsh-worktree-guard"
```

- `node_modules/dsh-worktree-guard` 是指向本仓库的 **junction**：仓库即安装，仓库更新后**重启 DSH** 即生效（无需再手工同步文件）。
- 插件依赖 `@deepseek-ai/schemastery` 经 junction 的 realpath 从**仓库自身** `node_modules` 解析（T0-S0.4 验证）。
- 注意：profile 根下手工存在的 `@deepseek-ai/{schemastery,cosmokit}`、`@standard-schema/spec` 不在 pnpm 依赖树里，跑 `pnpm install` 会被挪进 `node_modules/.ignored`（首次 link 安装时发生过，已挪回）。若将来执行了 profile 级 pnpm 命令，检查这三个包是否还在。

## 用例设计与结果（2026-11-11，安装版 0.2.4，39/39 通过）

### T0 安装完整性（5 项，自动）

| # | 用例 | 预期 | 结果 |
|---|---|---|---|
| S0.1 | 安装目录可达 | junction 或实体目录存在 | ✅ |
| S0.2 | 版本一致 | 安装版 `package.json` = 仓库版本（0.2.4） | ✅ |
| S0.3 | 入口导出齐全 | `name/inject/Config/apply/decideToolCall/repoConfig` 齐全；Config 为 schemastery Schema（可调用 + `.meta`） | ✅ |
| S0.4 | 依赖解析 | 以 `src/index.js` 所在位置为基准 `require.resolve("@deepseek-ai/schemastery")` 成功 | ✅ |
| S0.5 | 文件零漂移 | 安装 `src/` 与仓库 `src/` 逐文件 SHA256 一致（17 个文件） | ✅ |

### T1 决策核心（10 项，自动，安装副本纯函数）

| # | 用例 | 预期 | 结果 |
|---|---|---|---|
| S1.1a | 绑定副本内写入 | allow | ✅ |
| S1.1b | 跨副本写入（未绑定） | deny，指引 `worktree_enter` 采用 | ✅ |
| S1.2a | 未绑定主 checkout 推当前受保护分支 | allow + `allow_protected_push` 审计（issue #1 策略） | ✅ |
| S1.2b | 绑定会话推受保护分支 | deny | ✅ |
| S1.2c | `--dry-run` | allow（只读） | ✅ |
| S1.2d | `--force` | deny（破坏性） | ✅ |
| S1.3a | 隔离等级 rooted + 围栏 | `structural` | ✅ |
| S1.3b | 隔离等级 adopted | `disciplinary` 且原因含 `adopted-copy-not-root` | ✅ |
| S1.4a | 绑定模式分类 | 嵌套副本 → adopted，rel = `.worktrees/worktree-alpha` | ✅ |
| S1.4b/c | 词级采用安全性 | `../`、绝对路径、URL 不改写；`src/a.ts` 不映射；副本前缀正确映射（norm 后比较） | ✅ |

### T2 工具层全生命周期（24 项，自动，安装副本 + 临时真实仓库 + wire 形状参数）

| # | 用例 | 预期 | 结果 |
|---|---|---|---|
| S2.1 | `worktree_create{task_name,task_brief}` | 副本+分支+`.dsh/task-brief.md`；summary 首选 enter 采用；isolation=disciplinary | ✅ |
| S2.2 | `worktree_status`（未绑定） | copies 在列；isolation=disciplinary；next_actions[0] 指向 enter | ✅ |
| S2.3 | `worktree_enter`（主 checkout 会话，嵌套副本） | **就地采用**（bound+adopted，无需新开工作区） | ✅ |
| S2.4a | 采用后写副本内（绝对路径） | allow | ✅ |
| S2.4b | 采用后写主 checkout | deny + **副本前缀重试路径**（单轮可执行，C1 诚实） | ✅ |
| S2.4c | 写其他副本 | deny（跨副本） | ✅ |
| S2.4d | `bash -c 'cd <副本> && git push origin main'` | deny（受保护分支，经副本路由判定） | ✅ |
| S2.4e | `git push --dry-run` | allow | ✅ |
| S2.4f | danger-full-access 绑定网（C9） | deny，采用不解锁 | ✅ |
| S2.5 | `worktree_status`（采用后） | mode=adopted；原因含 adopted-copy-not-root | ✅ |
| S2.6a | standingLine（adopted） | 说明采用模式与前缀路径用法 | ✅ |
| S2.6b | sessionStartText（有副本未绑定） | ≤3 行、点名等级与 enter 路径 | ✅ |
| S2.7a | `worktree_remove` 无 confirm_remove | needConfirm（门不变） | ✅ |
| S2.7b | `{confirm_remove:true, delete_branch:true}`（snake_case 全链路） | 副本删除 + 已合并分支删除（**issue #5 核心回归**） | ✅ |
| S2.8a | 未合并 + delete_branch | 整个删除被拒（merged-only 硬规则） | ✅ |
| S2.8b | 不带 delete_branch 重试 | 副本删、分支保留 | ✅ |
| S2.9a | 会话根=副本 的 enter | rooted 绑定，isolation=structural | ✅ |
| S2.9b | `worktree_exit{action:"remove"}` | 解绑+副本+已合并分支全清 | ✅ |
| S2.10 | `worktree_prune{dry_run:true}` | dryRun=true 无错 | ✅ |
| S2.11 | approval=never 会话调 `worktree_authorize_main` | **deny + 人工通道**（issue #1 回归，不再返回注定失败的 ask） | ✅ |
| S2.11b | approval=ask 会话 | ask（P4 门保留） | ✅ |
| S2.12 | `worktree_allow{action:"list"}` | entries 返回 | ✅ |
| S2.14 | 审计落盘 | audit.jsonl 含 create / enter(mode:adopted) / remove 记录 | ✅ |

### 首轮执行的脚本校准记录（诚实披露）

首轮 35/39：4 个失败全部是**冒烟脚本自身断言错误**，非产品缺陷——S1.4b/c 用未归一化路径做全等比较（win32 盘符大小写）；S0.3 假设 schemastery Schema 有 `.validate`（实为可调用函数 + `.meta`）；S0.4 猜错依赖入口文件名（实为 `lib/index.cjs`，正确做法是按 `index.js` 的解析规则 `require.resolve`）。已修正并复跑通过。教训与 issue #5 同源：**测试代码对被测对象的假设也必须被验证**。

## T3 活体冒烟清单（宿主重启后人工执行）

宿主进程在启动时加载插件；**本会话宿主仍是旧构建**，以下用例在重启 DSH 后的新会话里执行，逐条打勾：

| # | 操作 | 预期 |
|---|---|---|
| L1 | 重启后新开会话，查看可用工具 | `worktree_create/enter/exit/status/remove/prune/authorize_main/revoke_main/allow` 全部注册 |
| L2 | 主 checkout 会话调 `worktree_create{task_name:"smoke"}` | 成功；summary 第一条"下一步"是会话内采用（enter），不是"新开会话" |
| L3 | 同会话调 `worktree_enter{path:<副本>}` | `bound:true, mode:"adopted"`；无需任何 GUI 工作区操作 |
| L4 | 采用后 `write` 写 `<repo>/.worktrees/worktree-smoke/x.txt` | 成功，文件落在副本内 |
| L5 | 采用后 `write` 写相对路径 `src/x.ts` | 被拦，deny 文案含副本前缀重试路径（`.worktrees/worktree-smoke/src/x.ts`） |
| L6 | `bash` 执行 `cd .worktrees/worktree-smoke && git status` | 允许执行，post-execute 附"采用模式"标记 |
| L7 | `git push --dry-run origin master`（未绑定主 checkout） | 放行（只读） |
| L8 | approval=never 会话调 `worktree_authorize_main` | 三段式 deny + CLI 人工通道（含 `wt.js` 绝对路径） |
| L9 | `worktree_status` | `isolation` 与当前形态一致（adopted→disciplinary）；`mode:"adopted"` |
| L10 | `worktree_remove{path, confirm_remove:true}` | 真实删除成功（不再死循环"需确认"） |
| L11 | 检查 `<repo>/.git/worktree-guard/audit.jsonl` | 本轮各操作均有审计行 |
| L12 | 读文档命令抽查（如检索含 `authorize-main` 的 README 行） | 只读检查链放行；真实执行仍拦（round-13/15 行为不回退） |

## 维护约定

- 发布新版本或更新 profile 安装后：先 `npm test`（源码层），再 `npm run smoke:installed`（安装层），两者都绿才算完成。
- 冒烟脚本与本文档同仓库提交；用例增删时两处同步改。

## 事故记录（2026-11-11，link 安装当天）

- 现象：执行 `pnpm add dsh-worktree-guard@link:…`（registry 版 → junction 替换）后不久，本仓库 `.git` 顶层文件（HEAD/config/index/hooks/info/logs 等）被删除；`objects/`、`refs/`（含 `refs/heads/master` 与全部 tags）、`ORIG_HEAD` 幸存。从幸存快照重建 HEAD/config 并 `git reset` 后历史完整恢复（`git fsck` 仅 dangling——历史重写前的旧提交，属预期）。
- 已排除：`pnpm install --offline` 对 junction 无害（受控实验：.git 条目前后不变）；冒烟脚本仅操作临时仓库。
- 未定论的头号嫌疑：`pnpm add` 的"包替换清理"经新建 junction 写穿到仓库（被并发 git 进程中断于 `objects/` 之前）。**若再次发生，即确认该路径，改用 `file:<tgz>` 安装并废弃 link。**
- 防线：`git bundle create <路径>.bundle --all` 的本地备份（本次已建 `F:\workspace_2\wtg-local-backup-20261111.bundle`）；以及尽早推送本地提交。
