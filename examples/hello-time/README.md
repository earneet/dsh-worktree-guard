# dsh-hello-time

一个最小的 DSH（DeepSeek Harness）插件示例：会话开始时注入当前时间问候，并向模型注册 `hello_now` 工具。

**它是按"教学项目"设计的**：约 80 行，覆盖 DSH 插件开发的全部核心概念——四个导出（`name` / `inject` / `Config` / `apply`）、事件监听（`agent/session-start`）、工具注册（四件套：name / description / parameters / output）、schemastery 配置、纯函数单测。

## 功能

- **会话问候**：新会话开始时注入一行 `[hello-time] 你好！现在是 2026-10-22 星期四 14:57（本机时间）。`
- **`hello_now` 工具**：模型可随时查询当前日期/时间/星期；可选参数 `style: "long"` 返回带秒格式（`HH:mm:ss`）。
- **可配置**（DSH 插件设置里）：`enable`（默认 true）、`greeting`（问候语，默认"你好"）。

## 安装（本地路径）

```bash
dsh plugin add <本目录的绝对路径>
```

或 GUI：设置 → 插件 → 添加插件 → 粘贴本目录绝对路径。改代码后卸载重装即可刷新。

## 开发

```bash
npm test   # 5 个单测（node --test --test-isolation=none，沙箱友好）
```

零依赖纯 ESM（Node ≥ 20；运行时仅依赖 @deepseek-ai/schemastery）。

## 目录导读（学习路线）

| 文件 | 学什么 |
|---|---|
| `package.json` | `dsh.bundle.patch` 字段：DSH 如何识别插件包 |
| `cordis.patch.yml` | 7 行挂载清单：插件如何"插"进宿主 |
| `src/index.js` | 全部核心：四导出 + 事件 + 工具注册 |
| `test/hello-time.test.js` | 纯函数单测 + 固定"假现在"技巧 |
| `SHARE-OUTLINE.md` | 30 分钟同事分享提纲 |
| `INSTALL.md` | 安装/卸载/升级操作脚本 |

## 教学谱系

配套完整范例：[dsh-worktree-guard](../../README.md)（本仓库主插件）——拦截工具调用（deny/ask/allow）、机械人闸、TTL 授权等进阶主题在那里都有真实实现。
