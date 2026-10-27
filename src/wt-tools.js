// wt-tools.js — the worktree_* native tools (create/enter/status/prune/remove,
// authorize-main, allow, etc.). Component C in the design doc (§8).
// DSH defineTool contract (measured via real host load, round-10): every tool
// MUST declare `output: { schema, render }` — `schema` is the object-root JSON
// Schema of the value `execute` RETURNS, `render(args, value)` produces the
// display blocks. Returning `{ content: [...] }` wrappers is not the contract.
import * as lifecycle from "./core/lifecycle.js";
import { commonDir, listWorktrees } from "./core/gitops.js";
import { bustGuardContextCache } from "./guard.js";
import { appendAudit, addAllowEntry, clearAllowlist, readAllowlist } from "./core/store.js";
import { authorizeMain, revokeMain } from "./core/authorize.js";
import { loadSidecar } from "./core/sidecar.js";
import { DEFAULT_AUTHORIZE_TTL_MIN, DEFAULT_ALLOW_TTL_MIN, ALLOW_TTL_CAP_MIN } from "./core/constants.js";
import { resolve as resolvePath } from "node:path";
import { norm } from "./core/paths.js";
import { CLI_PATH } from "./core/cli-path.js";

const blocks = (text) => [{ type: "text", text }];

/** m1 (round-5) + round-10: errors return the STRUCTURED `{ error }` value —
 *  the three-part contract lives in the render text, never a raw stack trace. */
function guarded(fn) {
  return async (args, exec) => {
    try {
      return await fn(args, exec);
    } catch (err) {
      return {
        error: `[worktree-guard] worktree 操作失败：${String(err?.message ?? err)}。原因：${err?.code === "ENOENT" ? "路径或 git 仓库不存在" : "前置条件不满足或参数无效"}。下一步：调用 worktree_status 盘点当前状态后重试。`,
      };
    }
  };
}

function renderError(value) {
  return value.error ? blocks(value.error) : null;
}

// ---- schema helpers (enforced JSON-subset: scalar type, properties, required
// ONLY on the parent object's array, boolean additionalProperties, items,
// enum/const, exact-one oneOf — `required` inside a scalar node is rejected) ----
const S = {
  // `required` args are accepted for readability but NOT emitted on the node;
  // parent objects declare requiredness via their own array.
  str: (_required = false, description) => ({ type: "string", ...(description ? { description } : {}) }),
  bool: () => ({ type: "boolean" }),
  int: () => ({ type: "integer" }),
  nullableStr: () => ({ oneOf: [{ type: "null" }, { type: "string" }] }),
  obj: (properties, required = []) => ({ type: "object", properties, required: required.filter((k) => properties[k]), additionalProperties: false }),
  loose: () => ({ type: "object", additionalProperties: true }),
  err: () => ({ type: "string", description: "three-part failure text when the operation failed" }),
};

const createDesc = `Create an isolated git worktree copy (branch worktree-<slug>) for a task. WHEN: starting a task that should not touch the main checkout. AFTER: open a NEW session rooted at the returned worktree path (that session's sandbox then anchors to the copy). The task description is stored in .dsh/task-brief.md inside the copy for the next session. Do NOT call for tasks meant to edit the main checkout directly.`;

const enterDesc = `Bind the CURRENT session to a worktree copy. Only meaningful when this session's working directory is already the worktree (rooted); a repo-root session will be refused with guidance. Call worktree_status first if unsure.`;

const exitDesc = `Unbind the current session from its worktree. action:"keep" keeps the copy; action:"remove" also removes it and deletes its branch when merged into base — the always-safe way to finish (a dirty copy is still refused; guard-owned .dsh/ files and links never count as dirty). Your own binding never blocks your own exit.`;

const statusDesc = `Worktree inventory and binding overview — the FIRST thing to call after being blocked by worktree-guard, or before finishing a task. Reports mode (rooted / repo-rooted / unbound), per-copy merged-into-HEAD proof, dirty state, stale bindings, and cleanup steps. unbound = a normal session with no copy bound: nothing to do here.`;

const authorizeDesc = `Authorize writes/merge to the protected main branch for a short TTL (default 15 minutes). REQUIRES the user to confirm interactively — the model CANNOT pass this gate by itself; call it ONLY after the user explicitly agreed and provide a clear reason. Each call re-prompts the user. If the host returns "the user rejected tool" while the user did NOT decline, the session's approval prompts are disabled (policy never): do NOT retry — tell the user to push/merge manually, to run node "${CLI_PATH}" authorize-main "<reason>" inside the target repo in their own interactive terminal (they must type the displayed confirmation code; repo-wide TTL), or to switch to a permission preset that prompts.`;

const allowDesc = `Temporarily allow ONE path pattern past the guard (TTL, default 60 minutes). REQUIRES interactive user confirmation — the model cannot pass this gate alone. Dangerous patterns (.git, bare root, *) are rejected. If the host returns "the user rejected tool" without showing the user a prompt, the approval channel is disabled (policy never): do NOT retry — ask the user to switch to a prompting preset, or to add the path to main_write_whitelist in the target repo's .dsh/worktree-guard.json themselves.`;

const removeDesc = `Remove a worktree copy (exit-first). Deletes its branch only when merged into base (proof via git merge-base). confirm_remove:true is required; pass delete_branch to also drop the merged branch.`;

const pruneDesc = `Recycle dead bindings: sessions whose worktree/branch no longer exist or that stayed silent past the threshold. dry_run:true lists without dropping.`;

const revokeDesc = `Revoke the active authorize-main grant immediately (before its TTL expires).`;

function str(name, desc) {
  return { type: "string", description: desc };
}
// round-11: call sites pass ONE description argument — a (name, desc) signature
// landed it in `name` and left `description: undefined`, which the lossless-JSON
// wire projection of request/header rejects ("non-JSON-serializable").
// round-12: parameters follow STRICT standard JSON Schema — `required` is a
// top-level name array ONLY (inline `required` in a property node is rejected
// by the host wire subset AND by strict provider APIs — GLM 400/1210).
function bool(desc) {
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
          task_name: str("task slug (lowercase, hyphens)", "short task name, e.g. \"fix-login\""),
          task_brief: str("task brief", "what the next session should know; stored in .dsh/task-brief.md"),
          base_ref: str("base ref", "branch/commit to start from (default: current main branch)"),
        },
        required: ["task_name"],
      },
      output: {
        schema: S.obj({
          worktree: S.str(true), branch: S.str(true), base: S.str(true), brief_path: S.str(true), error: S.err(),
        }, ["worktree", "branch", "base", "brief_path"]),
        render: (_a, v) => renderError(v) ?? blocks([
          `已创建副本：${v.worktree}`,
          `分支：${v.branch}（基于 ${v.base}）`,
          `下一步（推荐）：以副本为根新开会话（该会话沙箱自动锚定副本）。`,
          `若继续本会话：本会话未绑定副本，写文件务必用指向副本内的绝对路径——相对路径会落到主 checkout。`,
          `任务简报已写入 ${v.brief_path}`,
        ].join("\n")),
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        const cfg = await helpers.config(s.cwd);
        const r = await lifecycle.create({ taskName: args.task_name, taskBrief: args.task_brief, cwd: s.cwd, config: cfg });
        bustGuardContextCache(); // new copy visible to the net immediately (round-1 fix)
        return { worktree: r.worktree, branch: r.branch, base: r.base, brief_path: `${r.worktree}/.dsh/task-brief.md` };
      },
    },
    {
      name: "worktree_enter",
      description: enterDesc,
      parameters: { type: "object", properties: { path: str("worktree path", "path to the worktree copy") }, required: ["path"] },
      output: {
        schema: S.obj({
          bound: S.bool(true), worktree: S.str(), branch: S.str(), reason: S.str(), guidance: S.str(), error: S.err(),
        }, ["bound"]),
        render: (_a, v) => renderError(v) ?? blocks(
          v.bound
            ? `已绑定（rooted）：本会话根 = 副本 ${v.worktree}。读写路径必须解析到本副本内。`
            : `[worktree-guard] 已拒绝绑定：本会话根不是目标副本。\n原因：repo-rooted 绑定会造成读写分裂（读主根世界、写被逐次拦截）。\n下一步：${v.guidance ?? "以目标副本为会话根新开会话（推荐），获得结构性隔离。"}`,
        ),
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        // A repo-rooted session must not bind: without structural isolation it
        // would read the main checkout's world while every write gets denied,
        // i.e. a permanent deny loop. Refuse and hand back guidance instead
        // (design §8).
        const target = resolvePath(s.cwd, args.path ?? ".");
        if (norm(s.cwd) !== norm(target)) {
          return { bound: false, reason: "repo-rooted 绑定会造成读写分裂", guidance: `以 ${target} 为会话根新开会话（推荐），获得结构性隔离。` };
        }
        const binding = await lifecycle.enter({ path: args.path, sessionId: s.id, cwd: s.cwd });
        return { bound: true, worktree: binding.worktree, branch: binding.branch ?? "" };
      },
    },
    {
      name: "worktree_exit",
      description: exitDesc,
      parameters: {
        type: "object",
        properties: { action: { type: "string", description: "keep | remove", enum: ["keep", "remove"] } },
      },
      output: {
        schema: S.obj({ exited: S.bool(true), worktree: S.str(), message: S.str(), result: S.loose(), error: S.err() }, ["exited"]),
        render: (_a, v) => renderError(v) ?? blocks(
          v.exited
            ? `已解绑${v.worktree ? `：${v.worktree}` : ""}。` + (v.result ? `\n${JSON.stringify(v.result, null, 2)}` : "")
            : (v.message ?? "本会话没有绑定。"),
        ),
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        const cfg = await helpers.config(s.cwd);
        const r = await lifecycle.exitSession({ sessionId: s.id, cwd: s.cwd, action: args.action ?? "keep", config: cfg });
        if (r.exited === false) return { exited: false, message: r.message ?? "本会话没有绑定。" };
        if (r.removed !== undefined) return { exited: true, result: r };
        return { exited: true, worktree: r.worktree };
      },
    },
    {
      name: "worktree_status",
      description: statusDesc,
      parameters: { type: "object", properties: {} },
      output: {
        schema: S.obj({
          mode: { type: "string", enum: ["rooted", "repo-rooted", "unbound"] },
          binding: { oneOf: [{ type: "null" }, S.loose()] },
          copies: { type: "array", items: S.loose() },
          stale_state_hint: S.nullableStr(),
          orphan_dirs: { type: "array", items: { type: "string" } },
          error: S.err(),
        }, ["mode", "copies"]),
        render: (_a, v) => {
          const e = renderError(v);
          if (e) return e;
          const lines = [
            `模式：${v.mode}${v.binding?.worktree ? `（绑定 ${v.binding.worktree}）` : ""}`,
            ...(v.stale_state_hint ? [`提示：上会话副本未收尾（${v.stale_state_hint}）：调 worktree_status 盘点，将未收尾副本与清理建议报告用户。`] : []),
            ...v.copies.map((c) =>
              ` - ${c.name} [${c.branch ?? "?"}] ${c.merged_into_head ? "已合并(证明)" : "未合并"}${c.dirty ? " 有未提交变更" : ""}${c.stale ? " ⚠️stale绑定" : ""}`),
          ];
          return blocks(lines.join("\n"));
        },
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        return await lifecycle.status({ cwd: s.cwd, sessionId: s.id });
      },
    },
    {
      name: "worktree_remove",
      description: removeDesc,
      parameters: {
        type: "object",
        properties: {
          path: str("worktree path", "path to the copy"),
          confirm_remove: bool("must be true"),
          delete_branch: bool("also delete the branch (merged only)"),
        },
        required: ["path"],
      },
      output: {
        schema: S.obj({
          removed: S.bool(true), needConfirm: S.bool(), path: S.str(), branch: S.str(), branchKept: S.bool(), message: S.str(), error: S.err(),
        }, ["removed"]),
        render: (_a, v) => renderError(v) ?? blocks(v.message ?? (v.removed ? `已删除副本${v.branch ? `（分支 ${v.branchKept ? "保留" : "已删"}）` : ""}。` : "需确认：confirm_remove:true 后重试。")),
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        const cfg = await helpers.config(s.cwd);
        const r = await lifecycle.remove({ ...args, cwd: s.cwd, config: cfg, sessionId: s.id });
        bustGuardContextCache();
        return r;
      },
    },
    {
      name: "worktree_prune",
      description: pruneDesc,
      parameters: { type: "object", properties: { dry_run: bool("list only, drop nothing") } },
      output: {
        schema: S.obj({
          dryRun: S.bool(true), dropped: { type: "array", items: S.loose() }, error: S.err(),
        }, ["dryRun", "dropped"]),
        render: (_a, v) => renderError(v) ?? blocks(
          v.dropped.length === 0 ? "无可回收绑定。"
            : `${v.dryRun ? "[dry-run] 将回收" : "已回收"} ${v.dropped.length} 个绑定：\n` + v.dropped.map((d) => ` - ${d.sessionId}（${d.worktree}）：${d.reason}`).join("\n"),
        ),
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        return await lifecycle.prune({ cwd: s.cwd, dryRun: !!args.dry_run });
      },
    },
    {
      name: "worktree_authorize_main",
      description: authorizeDesc,
      parameters: {
        type: "object",
        properties: {
          reason: str("why main needs to be written/merged", "audited, shown to the user"),
          ttl_minutes: { type: "number", description: `TTL minutes (default ${DEFAULT_AUTHORIZE_TTL_MIN})` },
        },
        required: ["reason"],
      },
      output: {
        schema: S.obj({ authorized: S.bool(true), expiresAt: S.str(true), error: S.err() }, ["authorized", "expiresAt"]),
        render: (_a, v) => renderError(v) ?? blocks(`已授权写主分支，${v.expiresAt} 自动失效。`),
      },
      async execute(args, exec) {
        // P4: the pre-execute ask gate already confirmed with the user by the time we run.
        const s = helpers.sessionOf(exec);
        const cd = await commonDir(s.cwd);
        const { mainRoot } = await listWorktrees(s.cwd);
        const sidecar = await loadSidecar(mainRoot);
        const r = await authorizeMain({
          commonDir: cd,
          reason: args.reason ?? "",
          ttlMinutes: Number(args.ttl_minutes) || sidecar.authorizeTtlMinutes,
          by: "user-ask-gate",
          session: s.id,
          confirm: async () => true, // ask gate confirmed upstream (P4)
        });
        if (!r.authorized) throw new Error("authorization was not confirmed"); // defensive: cannot happen with a true confirm
        return { authorized: true, expiresAt: r.expiresAt };
      },
    },
    {
      name: "worktree_revoke_main",
      description: revokeDesc,
      parameters: { type: "object", properties: {} },
      output: {
        schema: S.obj({ revoked: S.bool(true), error: S.err() }, ["revoked"]),
        render: (_a, v) => renderError(v) ?? blocks("已收回主分支写授权。"),
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        await revokeMain({ commonDir: await commonDir(s.cwd), by: "worktree-tool", session: s.id });
        return { revoked: true };
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
      output: {
        schema: S.obj({
          action: S.str(true), path: S.str(), expiresAt: S.str(), entries: { type: "object", additionalProperties: true }, error: S.err(),
        }, ["action"]),
        render: (_a, v) => renderError(v) ?? blocks(
          v.action === "add" ? `已放行 ${v.path}，${v.expiresAt} 失效。`
            : v.action === "list" ? `allowlist：\n${JSON.stringify(v.entries ?? {}, null, 2)}`
            : "allowlist 已清空。",
        ),
      },
      async execute(args, exec) {
        const s = helpers.sessionOf(exec);
        const cd = await commonDir(s.cwd);
        if (args.action === "list") {
          const a = await readAllowlist(cd);
          return { action: "list", entries: a.entries ?? {} };
        }
        if (args.action === "clear") {
          await clearAllowlist(cd);
          return { action: "clear" };
        }
        // add — P4 gate confirmed upstream; key is repo-absolute (round-2 fix)
        const { mainRoot } = await listWorktrees(s.cwd);
        const sidecar = await loadSidecar(mainRoot);
        const ttl = Math.max(1, Math.min(Number(args.ttl_minutes) || sidecar.allowlistTtlMinutes || DEFAULT_ALLOW_TTL_MIN, ALLOW_TTL_CAP_MIN));
        const e = await addAllowEntry(cd, { path: args.path, reason: args.reason, ttlMinutes: ttl, grantedBy: "user-ask-gate", mainRoot });
        await appendAudit(cd, { type: "allow_add", session: s.id, ...e });
        return { action: "add", path: e.path, expiresAt: e.expires_at };
      },
    },
  ];
  // Wrap every execute so errors surface as three-part deny messages
  // (what/why/single-turn next step) per the communication contract (§7).
  return raw.map((s) => ({ ...s, execute: guarded(s.execute) }));
}
