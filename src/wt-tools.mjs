// wt-tools.mjs — component C (design §8): worktree_* native tools.
// Tool definitions follow the DSH defineTool shape (dsh-tool-todo lineage):
// name, description (three-part contract §7 channel 1), string param schema,
// async execute(args, exec). Registered by index.mjs via ctx.tools.register.
import * as lifecycle from "./core/lifecycle.mjs";
import { commonDir, listWorktrees } from "./core/gitops.mjs";
import { bustGuardContextCache } from "./guard.mjs";
import { updateState, appendAudit, addAllowEntry, clearAllowlist, readAllowlist } from "./core/store.mjs";
import { loadSidecar } from "./core/sidecar.mjs";
import { DEFAULT_AUTHORIZE_TTL_MIN, DEFAULT_ALLOW_TTL_MIN, AUTHORIZE_TTL_CAP_MIN, ALLOW_TTL_CAP_MIN } from "./core/constants.mjs";
import { resolve as resolvePath } from "node:path";
import { norm } from "./core/paths.mjs";

/**
 * m1 (round-5): lifecycle errors must still honor the §7 three-part contract —
 * never let a raw stack-trace-shaped message reach the model.
 */
function guarded(text) {
  return async (args, exec) => {
    try {
      return await text(args, exec);
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `[worktree-guard] worktree 操作失败：${String(err?.message ?? err)}。\n原因：${err?.code === "ENOENT" ? "路径或 git 仓库不存在" : "前置条件不满足或参数无效"}。\n下一步：调用 worktree_status 盘点当前状态后重试。`,
        }],
      };
    }
  };
}

function textOut(lines) {
  return { content: [{ type: "text", text: Array.isArray(lines) ? lines.join("\n") : lines }] };
}

const createDesc = `Create an isolated git worktree copy (branch worktree-<slug>) for a task. WHEN: starting a task that should not touch the main checkout. AFTER: open a NEW session rooted at the returned worktree path (that session's sandbox then anchors to the copy). The task description is stored in .dsh/task-brief.md inside the copy for the next session. Do NOT call for tasks meant to edit the main checkout directly.`;

const enterDesc = `Bind the CURRENT session to a worktree copy. Only meaningful when this session's working directory is already the worktree (rooted); a repo-root session will be refused with guidance. Call worktree_status first if unsure.`;

const exitDesc = `Unbind the current session from its worktree. action:"keep" keeps the copy; action:"remove" also removes it (merged branches only) — the always-safe way to finish. Your own binding never blocks your own exit.`;

const statusDesc = `Worktree inventory and binding overview — the FIRST thing to call after being blocked by worktree-guard, or before finishing a task. Reports mode (rooted/repo-rooted/unbound), per-copy merged-into-HEAD proof (git merge-base --is-ancestor), dirty state, stale bindings, and cleanup steps.`;

const authorizeDesc = `Authorize writes/merge to the protected main branch for a short TTL (default 15 minutes). REQUIRES the user to confirm interactively — the model CANNOT pass this gate by itself; call it ONLY after the user explicitly agreed, repeated calls will be asked again. Provide a clear reason.`;

const allowDesc = `Temporarily allow ONE path pattern past the guard (TTL, default 60 minutes). REQUIRES interactive user confirmation — the model cannot pass this gate alone. Dangerous patterns (.git, bare root, *) are rejected.`;

const removeDesc = `Remove a worktree copy (exit-first). Deletes its branch only when merged into base (proof via git merge-base). confirm_remove:true is required; pass delete_branch to also drop the merged branch.`;

const pruneDesc = `Recycle dead bindings: sessions whose worktree/branch no longer exist or that stayed silent past the threshold. dry_run:true lists without dropping.`;

const revokeDesc = `Revoke the active authorize-main grant immediately (before its TTL expires).`;

function str(name, desc, required = false) {
  return { type: "string", description: desc, ...(required ? { required: true } : {}) };
}
function bool(name, desc) {
  return { type: "boolean", description: desc };
}

export function toolSpecs(helpers) {
  // helpers: { sessionOf(exec) -> {id,cwd,parentSession}, config() -> repo+plugin config, askUser(...)? }
  const raw = [
    {
      name: "worktree_create",
      description: createDesc,
      parameters: {
        type: "object",
        properties: {
          task_name: str("task slug (lowercase, hyphens)", "short task name, e.g. \"fix-login\"", true),
          task_brief: str("task brief", "what the next session should know; stored in .dsh/task-brief.md"),
          base_ref: str("base ref", "branch/commit to start from (default: current main branch)"),
        },
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        const cfg = await helpers.config(s.cwd);
        const r = await lifecycle.create({ taskName: args.task_name, taskBrief: args.task_brief, cwd: s.cwd, config: cfg });
        bustGuardContextCache(); // new copy visible to the net immediately (round-1 fix)
        return {
          content: [{
            type: "text",
            text: [
              `已创建副本：${r.worktree}`,
              `分支：${r.branch}（基于 ${r.base}）`,
              `下一步：以副本为根新开会话（推荐），或继续本会话并遵守相对路径纪律。`,
              `任务简报已写入 ${r.worktree}/.dsh/task-brief.md`,
            ].join("\n"),
          }],
        };
      },
    },
    {
      name: "worktree_enter",
      description: enterDesc,
      parameters: { type: "object", properties: { path: str("worktree path", "path to the worktree copy", true) } },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        // Design §8: repo-rooted sessions refuse enter and get guidance instead —
        // binding without structural isolation causes the deny-loop failure mode.
        const target = resolvePath(s.cwd, args.path ?? ".");
        if (norm(s.cwd) !== norm(target)) {
          return {
            content: [{
              type: "text",
              text: `[worktree-guard] 已拒绝绑定：本会话根不是目标副本。\n原因：repo-rooted 绑定会造成读写分裂（读主根世界、写被逐次拦截）。\n下一步：以 ${target} 为会话根新开会话（推荐），获得结构性隔离。`,
            }],
          };
        }
        const binding = await lifecycle.enter({ path: args.path, sessionId: s.id, cwd: s.cwd });
        return {
          content: [{
            type: "text",
            text: `已绑定（rooted）：本会话根 = 副本 ${binding.worktree}。读写一律相对路径。`,
          }],
        };
      },
    },
    {
      name: "worktree_exit",
      description: exitDesc,
      parameters: {
        type: "object",
        properties: { action: { type: "string", description: "keep | remove", enum: ["keep", "remove"] } },
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        const cfg = await helpers.config(s.cwd);
        const r = await lifecycle.exitSession({ sessionId: s.id, cwd: s.cwd, action: args.action ?? "keep", config: cfg });
        return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
      },
    },
    {
      name: "worktree_status",
      description: statusDesc,
      parameters: { type: "object", properties: {} },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        const r = await lifecycle.status({ cwd: s.cwd, sessionId: s.id });
        const lines = [
          `模式：${r.mode}${r.binding ? `（绑定 ${r.binding.worktree}）` : ""}`,
          ...(r.stale_state_hint ? [`提示：上会话副本未收尾（${r.stale_state_hint}）`] : []),
          ...r.copies.map((c) =>
            ` - ${c.name} [${c.branch ?? "?"}] ${c.merged_into_head ? "已合并(证明)" : "未合并"}${c.dirty ? " 有未提交变更" : ""}${c.stale ? " ⚠️stale绑定" : ""}`),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },
    {
      name: "worktree_remove",
      description: removeDesc,
      parameters: {
        type: "object",
        properties: {
          path: str("worktree path", "path to the copy", true),
          confirm_remove: bool("must be true"),
          delete_branch: bool("also delete the branch (merged only)"),
        },
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        const cfg = await helpers.config(s.cwd);
        const r = await lifecycle.remove({ ...args, cwd: s.cwd, config: cfg, sessionId: s.id });
        bustGuardContextCache();
        return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
      },
    },
    {
      name: "worktree_prune",
      description: pruneDesc,
      parameters: { type: "object", properties: { dry_run: bool("list only, drop nothing") } },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        const r = await lifecycle.prune({ cwd: s.cwd, dryRun: !!args.dry_run });
        return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
      },
    },
    {
      name: "worktree_authorize_main",
      description: authorizeDesc,
      parameters: {
        type: "object",
        properties: {
          reason: str("why main needs to be written/merged", "audited, shown to the user", true),
          ttl_minutes: { type: "number", description: `TTL minutes (default ${DEFAULT_AUTHORIZE_TTL_MIN})` },
        },
      },
      async execute(args, exec) {
        // P4: the pre-execute ask gate already confirmed with the user by the time we run.
        const s = helpers.sessionOf(exec);
        const cd = await commonDir(s.cwd);
        const { mainRoot } = await listWorktrees(s.cwd);
        const sidecar = await loadSidecar(mainRoot);
        const ttl = Math.max(1, Math.min(Number(args.ttl_minutes) || sidecar.authorizeTtlMinutes || DEFAULT_AUTHORIZE_TTL_MIN, AUTHORIZE_TTL_CAP_MIN));
        const st = await updateState(cd, {
          allow_main_writes: {
            allow_main_writes: true,
            allow_reason: args.reason ?? "",
            allow_at: new Date().toISOString(),
            allow_expires_at: new Date(Date.now() + ttl * 60_000).toISOString(),
            allow_by: "user-ask-gate",
          },
        });
        await appendAudit(cd, { type: "authorize_main", session: s.id, reason: args.reason, ttl_minutes: ttl });
        return { content: [{ type: "text", text: `已授权写主分支，${st.allow_main_writes.allow_expires_at} 自动失效。` }] };
      },
    },
    {
      name: "worktree_revoke_main",
      description: revokeDesc,
      parameters: { type: "object", properties: {} },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        const cd = await commonDir(s.cwd);
        await updateState(cd, { allow_main_writes: {} });
        await appendAudit(cd, { type: "revoke_main", session: s.id });
        return { content: [{ type: "text", text: "已收回主分支写授权。" }] };
      },
    },
    {
      name: "worktree_allow",
      description: allowDesc,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "add | list | clear", enum: ["add", "list", "clear"] },
          path: str("relative path/pattern", "single path to allow"),
          reason: str("why", "audited, shown to the user"),
          ttl_minutes: { type: "number", description: `TTL minutes (default ${DEFAULT_ALLOW_TTL_MIN})` },
        },
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        const cd = await commonDir(s.cwd);
        if (args.action === "list") {
          const a = await readAllowlist(cd);
          return { content: [{ type: "text", text: JSON.stringify(a.entries ?? {}, null, 2) }] };
        }
        if (args.action === "clear") {
          await clearAllowlist(cd);
          return { content: [{ type: "text", text: "allowlist 已清空。" }] };
        }
        // add — P4 gate confirmed upstream; key is repo-absolute (round-2 fix)
        const { mainRoot } = await listWorktrees(s.cwd);
        const sidecar = await loadSidecar(mainRoot);
        const ttl = Math.max(1, Math.min(Number(args.ttl_minutes) || sidecar.allowlistTtlMinutes || DEFAULT_ALLOW_TTL_MIN, ALLOW_TTL_CAP_MIN));
        const e = await addAllowEntry(cd, { path: args.path, reason: args.reason, ttlMinutes: ttl, grantedBy: "user-ask-gate", mainRoot });
        await appendAudit(cd, { type: "allow_add", session: s.id, ...e });
        return { content: [{ type: "text", text: `已放行 ${e.path}，${e.expires_at} 失效。` }] };
      },
    },
  ];
  // every execute gets the §7 three-part error contract (round-5 m1)
  return raw.map((s) => ({ ...s, execute: guarded(s.execute) }));
}
