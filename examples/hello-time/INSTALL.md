# hello-time · 安装到真实 DSH（第 7 课操作脚本）

> 依据：宿主文档确认，添加插件接受「包名（可带版本）、Git 地址、压缩包或本地绝对路径」。

## 方式 A：GUI（推荐演示用）

1. 打开 DSH 设置 → **插件** → 添加插件；
2. 在包名输入框粘贴本插件的**绝对路径**：
   ```
   F:\workspace_2\dsh-worktree-guard\examples\hello-time
   ```
3. 勾选信任提示 → **安装**；
4. 新开一个会话，验证两件事：
   - 会话开头出现 `[hello-time] 你好！现在是 …`（session-start 注入生效）；
   - 对模型说"现在几点了？"，它应调用 `hello_now` 工具。

## 方式 B：CLI

```bash
dsh plugin add F:\workspace_2\dsh-worktree-guard\examples\hello-time
dsh plugin list   # 应看到 hello-time
```

## 卸载 / 升级（同事常问）

- 卸载：插件页对应条目移除，或 `dsh plugin remove hello-time`；
- 本地路径安装的插件：**改代码后卸载重装**即可刷新（宿主文档：非官方按需插件通过卸载后重新安装升级）。

## 演示时的讲解点

- 安装的入口之所以认识这个目录，是因为 `package.json` 里有 `dsh.bundle.patch` 字段 → 指向 `cordis.patch.yml`（第 1 课的加载流程在真实宿主上走了一遍）；
- 工具出现在会话里 = `ctx.tools.register` 生效；开场问候 = `ctx.on("agent/session-start")` 生效。
