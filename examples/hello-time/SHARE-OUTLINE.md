# DSH 插件开发 · 30 分钟分享提纲

> 面向同事的内部分享，配套演示项目：`examples/hello-time`（约 70 行）。
> 讲解策略：先给"一张地图"，再"解剖一只麻雀"，最后现场写一个。

## 0. 开场提问（2 分钟）

- "大家有没有想过：会话里那些工具是谁给的？能不能自己加一个？"
- 定位：插件 = 给 DSH 宿主扩展能力，不用改宿主一行代码。

## 1. 一张地图（5 分钟）

```
npm 包 ──dsh.bundle.patch──▶ cordis.patch.yml ──▶ 宿主加载 apply(ctx, config)
                                                    ├─ ctx.on(...)         听事件、可拦截
                                                    ├─ ctx.tools.register  给模型新工具
                                                    └─ Config / sidecar    用户配置
```

三个角色：**DSH 是宿主，cordis 是插件框架，插件是普通 npm 包 + 两个约定文件**。

## 2. 四个导出（5 分钟）

| 导出 | 作用 | 一句话 |
|---|---|---|
| `name` | 标识 | 我是谁 |
| `inject` | 服务依赖 | 我需要什么才能活 |
| `Config` | 配置+校验 | 用户能改什么（必须是 schemastery Schema，普通对象会激活失败） |
| `apply(ctx, config)` | 插件本体 | 装好后干的事 |

## 3. 现场演示：hello-time（10 分钟）

1. 打开 `examples/hello-time/`，逐文件讲：package.json 的 `dsh` 字段 → 7 行的 patch.yml → index.js。
2. 重点讲两段代码：
   - `ctx.on("agent/session-start", ...)`：中间件模式，`await next()` 先放行再注入；
   - `ctx.tools.register({...})`：四件套 `name / description / parameters / output{schema,render} / execute`。
3. 三条血泪契约（都来自真实踩坑）：
   - `output` 必须有 `schema + render`，`execute` 直接返回数据，不包 `content`；
   - `description` 是写给模型的行为说明书（WHEN / AFTER / Do NOT 句式）；
   - `parameters` 用严格 JSON Schema，`required` 只出现在顶层。
4. 事件速查：`agent/session-start`、`agent/pre-step`、`tools/pre-execute`（deny/ask/allow 三种判决）、`tools/post-execute`、`agent/disposed`。

## 4. 配置两层模式（3 分钟）

- 全局层：Config + `.default()`，开箱即用；
- 仓库层：sidecar（`<repo>/.dsh/xxx.json`），代码归 npm 包、数据归用户仓库。

## 5. 工程习惯（3 分钟）

- 逻辑拆纯函数（如 `nowText()`），不用启动宿主就能单测；
- 防御式写法：`try/catch` + 可选链，插件崩了不能连累宿主（fail-open）；
- `node --test` 跑测试；`node --check` 做最快速检。

## 6. 收尾（2 分钟）

- 安装：`dsh plugin add <包名>`（或 GUI 设置 → 插件）；
- 进阶参考：本仓库 `dsh-worktree-guard` 就是一个 600+ 行、已发布 npm 的完整范例（拦截、人闸、收尾清理）；
- 留一个动手题：给 `hello_now` 加 `style` 参数（就是本课程的作业）。

## 附：演示环境准备清单

- [ ] Node ≥ 20；
- [ ] 本仓库 checkout（演示 hello-time + 展示 worktree-guard 源码）；
- [ ] 一个装了插件的 DSH 会话，现场问"现在几点"触发 `hello_now`。
