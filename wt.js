#!/usr/bin/env node
// wt.js — human/script CLI over the same core as the native tools (§8).
// Zero-dependency ESM (zcode wt.js lineage). Sessions pass --session explicitly
// (CLI runs outside a DSH session).
import { parseArgs } from "node:util";
import { cwd as processCwd } from "node:process";
import * as lifecycle from "./src/core/lifecycle.js";
import { commonDir, listWorktrees } from "./src/core/gitops.js";
import { loadSidecar as repoConfig } from "./src/core/sidecar.js";
import { authorizeMain, revokeMain, clampAuthorizeTtl } from "./src/core/authorize.js";
import { confirmTyped } from "./src/core/human-gate.js";
import { randomBytes } from "node:crypto";

const HELP = `wt — dsh-worktree-guard CLI（与 worktree_* 工具同一 core）

用法:
  wt create <task_name> [--brief <text>] [--base <ref>]
  wt enter <path> --session <id>
  wt exit [--action keep|remove] --session <id>
  wt remove <path> [--confirm-remove] [--delete-branch] [--force]
  wt status [--session <id>]
  wt prune [--dry-run]
  wt authorize-main <reason> [--ttl-minutes <n>]     # 人工通道：交互式终端 + 键入随机确认码
  wt revoke-main
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(HELP);
    return 0;
  }
  const { positionals, values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      brief: { type: "string" },
      base: { type: "string" },
      session: { type: "string", default: "cli" },
      action: { type: "string", default: "keep" },
      "confirm-remove": { type: "boolean", default: false },
      "delete-branch": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "ttl-minutes": { type: "string" },
    },
  });
  const cwd = processCwd();
  const config = await repoConfig(cwd);

  switch (cmd) {
    case "create": {
      const r = await lifecycle.create({ taskName: positionals[0], taskBrief: values.brief, cwd, config: { ...config, baseRef: values.base ?? config.baseRef } });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case "enter": {
      const r = await lifecycle.enter({ path: positionals[0], sessionId: values.session, cwd });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case "exit": {
      const r = await lifecycle.exitSession({ sessionId: values.session, cwd, action: values.action, config: { ...config, force: values.force } });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case "remove": {
      const r = await lifecycle.remove({ path: positionals[0], cwd, confirmRemove: values["confirm-remove"], deleteBranch: values["delete-branch"], config: { ...config, force: values.force }, sessionId: values.session });
      console.log(JSON.stringify(r, null, 2));
      return r.removed || r.needConfirm ? 0 : 1;
    }
    case "status": {
      const r = await lifecycle.status({ cwd, sessionId: values.session });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case "prune": {
      const r = await lifecycle.prune({ cwd, dryRun: values["dry-run"] });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case "authorize-main": {
      // P4 human channel. TTY alone is NOT structural: a model can launch this
      // process in a programmatically created console (Start-Process/conhost/
      // python CREATE_NEW_CONSOLE) whose stdin reports isTTY=true with no human
      // present. The proof of a human is a TYPED confirmation — a launched
      // child has nobody to type and times out without writing any grant.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error("authorize-main 是人工通道：仅接受交互式终端调用。模型侧请使用 worktree_authorize_main 工具（需用户确认）；若本会话审批提示被禁用（approval=never），该工具也会被宿主自动拒绝——请用户亲自在交互式终端运行本命令，或手动推送/合并。");
        return 1;
      }
      const cd = await commonDir(cwd);
      const reason = positionals.join(" ") || "cli";
      // Per-invocation nonce, not a fixed "YES": a launched console can receive
      // ambient input (stray keystrokes / an auto-answerer), and a fixed phrase
      // is guessable. The code is displayed only on THIS terminal.
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      // sidecar authorize_ttl_minutes is a documented config field (§13) and is
      // resolved against the MAIN checkout root, like every other consumer (a
      // CLI invoked from a subdir must not silently miss it).
      const { mainRoot } = await listWorktrees(cwd).catch(() => ({ mainRoot: null }));
      const sidecar = mainRoot ? await repoConfig(mainRoot) : config;
      const ttlRequest = values["ttl-minutes"] || sidecar.authorizeTtlMinutes;
      const ttl = clampAuthorizeTtl(ttlRequest);
      console.log(`即将授权写主分支/推送受保护分支：${ttl} 分钟（仓库级 TTL，对本仓库所有会话生效）。`);
      console.log(`原因：${reason}`);
      const r = await authorizeMain({
        commonDir: cd,
        reason,
        ttlMinutes: ttlRequest,
        by: "cli-human",
        confirm: () => confirmTyped({ phrase: nonce, timeoutMs: 60_000 }),
      });
      if (!r.authorized) {
        console.error("未确认，已取消（未写入任何授权）。");
        return 1;
      }
      console.log(`已授权（${r.ttlMinutes} 分钟），${r.expiresAt} 失效`);
      return 0;
    }
    case "revoke-main": {
      await revokeMain({ commonDir: await commonDir(cwd), by: "cli-human" });
      console.log("已收回授权");
      return 0;
    }
    default:
      console.error(`未知命令：${cmd}\n`);
      console.log(HELP);
      return 2;
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  },
);
