# dsh-worktree-guard 安装版冒烟测试（smoke test）

> 目的：`npm test` 驱动的是**仓库源码**；issue #5 证明真正被用户打到的是**已安装副本**（profile `node_modules`），且"工具层 wire 形状参数 → lifecycle camelCase"这条边界曾有零覆盖。本冒烟针对安装副本执行，作为发布/更新后的第一道门禁。
>
> 执行方式：`npm run smoke:installed`（或 `node scripts/smoke-installed.mjs`）。默认目标是 desktop profile 的 `node_modules/dsh-worktree-guard`；用 `WTG_SMOKE_PATH=<路径>` 可冒烟任意安装（如 npm pack 解包目录）。无网络、不需要重启宿主。

## 安装形态（本轮起）

profile 依赖从 registry 版本号改为**本地 tarball 的 `file:` 安装**（与 profile 内 `dsh-vision-image-cap` 同模式，是宿主包管理器认可并保留的形态）：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dsh-worktree-guard": "file:./plugins/dsh-worktree-guard-0.2.4.tgz"
```

- `node_modules/dsh-worktree-guard` 是 pnpm 从 tarball 装出的**实体目录**（非 junction），版本即 tarball 版本。
- 依赖 `@deepseek-ai/schemastery` 由 pnpm 一并装入 store（T0-S0.4 验证解析）。
- **更新流程**：仓库 `npm pack` → 复制 tgz 到 `~/.dsh/profiles/desktop/plugins/` → package.json 的 `file:` 指向新文件名 → 宿主自带 pnpm `install` → `npm run smoke:installed`（S0.2/S0.5 会自动发现 tarball 落后于仓库）。
- ⚠️ **不要用 `link:` 安装**：宿主的插件/包管理器会周期性"修复" profile 依赖，把 link: junction 回退成 registry 实体目录（本轮实测：package.json、lockfile、node_modules 三处全部被回退到 0.2.3）；且首次 link 替换窗口内发生了仓库 `.git` 顶层被删事故（见下）。`file:` tarball 是该环境下唯一稳定的手工本地安装形态。

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

## T3 活体冒烟（2026-11-11 17:52–18:10，宿主重启后执行，loaded=重启时快照）

| # | 操作 | 预期 | 结果 |
|---|---|---|---|
| L1 | 重启后查工具注册（cordis inspect） | 9 个 worktree_* 全注册，描述为 0.2.4 文本 | ✅ |
| L2 | `worktree_create{task_name:"live-smoke"}` | 成功 + 采用优先指引 | ✅（首轮抓到 bug-1 已修复；18:20 重启后工具层复验通过：等级 + 采用指引 + WSL 提示完整返回） |
| L3 | `worktree_enter{path}` | bound+adopted | ✅（bug-2 同类已修复；重启后工具层复验通过：adopted 返回过宿主校验，文案标注"沙箱边界未移动"） |
| L4 | 采用后 write 副本内绝对路径 | allow | ✅（绑定前后同路径 对照：未绑定→跨副本拒；绑定→放行，采用路由真宿主生效） |
| L5 | 采用后 write 相对路径 `src/…` | deny + 副本前缀重试路径 | ✅ 文案精确给出 `.worktrees/worktree-live-smoke/src/...` |
| L6 | `bash -c 'cd <副本> && …'` | allow + "采用模式"标记 | ✅ 守卫放行 + post-execute 标记注入（真实可见）。**发现-4（环境）**：WSL bash 读不懂副本 `.git` 指针（Windows 绝对路径被当相对路径拼接）→ git 操作需 pwsh / `git -C`（已写进指引文案） |
| L7 | 未绑定 `git push --dry-run origin master` | 放行（只读） | ✅（git 确认将快进 d71d4b8..7831010，未发送） |
| L8 | approval=never 会话调 `worktree_authorize_main` | 三段式 deny + 人工通道 | ✅（issue #1 修复活体闭环，CLI 绝对路径内嵌） |
| L9 | `worktree_status` | adopted 模式 + 等级字段 | ✅ mode:adopted / isolation:disciplinary / 副本列示含合并证明与脏标记 |
| L10 | `worktree_remove{confirm_remove:true, delete_branch:true}` | 真删（不再死循环） | ✅ 先验证脏副本拒绝路径（加分），清标记后**副本+已合并分支真删**（issue #5 修复活体闭环） |
| L11 | 审计落盘 | 各操作均有记录 | ✅（606 行：read 标记 / deny_write 新文案 / enter mode:adopted / remove…） |
| L12 | 只读检索含 `authorize-main` 的文档 | 放行 | ✅（#1 附注的误报类修复不回退） |
| + | remove 后 status→prune | last_active 清理 | ✅（#3 行为活体可见） |

**本轮活体发现与处置**：
1. **bug-1（create schema 漂移）**、**bug-2（enter schema 漂移）**：宿主对 execute 返回做严格 schema 校验（`additionalProperties:false`），离线直调 execute 看不到。修复 + 新增 [test/round20-schema.test.js](../test/round20-schema.test.js) 离线强制 schema↔返回锁步。
2. **bug-3（required 与错误形状冲突）**：宿主同样校验错误返回——`guarded()` 的通用 `{error}` 形状违反任何 required 键。output schema 一律不再带 required。
3. **发现-4（WSL/git 边界）**：环境级，非插件缺陷；指引文案已注明 Windows 宿主 git 用 pwsh / `git -C`。
4. **C9 分级**：adopted 绑定不再触发 danger-full-access 一刀切（rooted 保留）。本轮会话的沙箱模式实际解析非 danger，未触发该路径；语义由测试覆盖（round18-I3 / smoke S2.4f）。
5. status 的 adopted 等级文案此前用了通用措辞，已改为采用专属（路由生效、边界未动）。

**遗留待下次重启后复验**：~~L2/L3 的工具层调用~~（18:20 重启后已复验通过，L1–L12 全绿）。T3 清单至此**全部闭环**。

## 维护约定

- 发布新版本或更新 profile 安装后：先 `npm test`（源码层），再 `npm run smoke:installed`（安装层），两者都绿才算完成。
- 冒烟脚本与本文档同仓库提交；用例增删时两处同步改。

## 事故记录（2026-11-11，安装切换当天，两起）

**① 仓库 `.git` 顶层被部分删除。** `pnpm add dsh-worktree-guard@link:…`（registry 版 → junction 替换）后不久，`.git` 的 HEAD/config/index/hooks/info/logs 等被删；`objects/`、`refs/`（含 `refs/heads/master` 与全部 tags）、`ORIG_HEAD` 幸存。从幸存快照重建 HEAD/config 并 `git reset`，历史完整恢复（`git fsck` 仅 dangling，属历史重写预期）。已排除：`pnpm install --offline` 对稳定 junction 无害（受控实验）；冒烟脚本仅操作临时仓库。头号嫌疑：**包替换清理经 junction 写穿**，被并发 git 进程中断于 `objects/` 之前（未定论；若复现即坐实，届时彻底弃用任何指向开发仓库的链接安装）。

**② link: 安装被宿主回退。** link: 装好并通过冒烟后，profile 的 package.json、pnpm-lock、node_modules 三处在数分钟内被回退成 registry 0.2.3 实体目录（宿主插件/包管理器的周期性 reconciliation；回退动作与事故①的替换流程同类）。处置：改用 `file:./plugins/*.tgz` 安装（宿主认可的本地形态，`dsh-vision-image-cap` 先例），重跑冒烟 39/39。

**防线**：`git bundle create <路径>.bundle --all` 本地备份（事故后已建）；尽早推送本地提交；改动手工 profile 状态后跑 `npm run smoke:installed` 确认未被回退。
