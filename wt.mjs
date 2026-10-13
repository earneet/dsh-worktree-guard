#!/usr/bin/env node
// wt.mjs — human/script CLI over the same core as the native tools (design §8).
// Zero-dependency ESM (zcode wt.mjs lineage). Sessions pass --session explicitly
// (CLI runs outside a DSH session).
import { parseArgs } from "node:util";
import { cwd as processCwd } from "node:process";
import * as lifecycle from "./src/core/lifecycle.mjs";
import { commonDir } from "./src/core/gitops.mjs";
import { repoConfig } from "./src/index.mjs";
import { updateState, appendAudit } from "./src/core/store.mjs";

const HELP = `wt — dsh-worktree-guard CLI（与 worktree_* 工具同一 core）

用法:
  wt create <task_name> [--brief <text>] [--base <ref>]
  wt enter <path> --session <id>
  wt exit [--action keep|remove] --session <id>
  wt remove <path> [--confirm-remove] [--delete-branch] [--force]
  wt status [--session <id>]
  wt prune [--dry-run]
  wt authorize-main <reason> [--ttl-minutes <n>]     # 人工通道：不经 ask 门，操作者即人
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
      // P4 structural gate: the CLI human channel only accepts INTERACTIVE
      // terminals — model shells are non-TTY, closing the obfuscation bypasses
      // of the lexical verb net (variable concat, quote insertion).
      if (!process.stdin.isTTY) {
        console.error("authorize-main 是人工通道：仅接受交互式终端调用。模型侧请使用 worktree_authorize_main 工具（需用户确认）。");
        return 1;
      }
      const cd = commonDir(cwd);
      const ttl = Math.max(1, Math.min(Number(values["ttl-minutes"]) || 15, 240));
      const st = await updateState(cd, {
        allow_main_writes: {
          allow_main_writes: true,
          allow_reason: positionals.join(" ") || "cli",
          allow_at: new Date().toISOString(),
          allow_expires_at: new Date(Date.now() + ttl * 60_000).toISOString(),
          allow_by: "cli-human",
        },
      });
      await appendAudit(cd, { type: "authorize_main", by: "cli-human", ttl_minutes: ttl });
      console.log(`已授权，${st.allow_main_writes.allow_expires_at} 失效`);
      return 0;
    }
    case "revoke-main": {
      const cd = commonDir(cwd);
      await updateState(cd, { allow_main_writes: {} });
      await appendAudit(cd, { type: "revoke_main", by: "cli-human" });
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
