// guard.mjs — component A/A' (design §4): tools/pre-execute safety net.
// deny-only by contract (DSH cannot rewrite args — contract C1); ask-gate for
// authorize/allow tools (P4). Fail policy (design §11): a throw here is
// fail-closed for free (host waterfall catches -> tool error). Read-side
// judgments self-catch to fail-open (discipline).
import { decideWrite, decideRead, decidePwsh } from "./core/decision.mjs";
import { resolveBinding, isRooted } from "./core/binding.mjs";
import { commonDir as gitCommonDirOf, listWorktrees, currentBranch, worktreeNameOf } from "./core/gitops.mjs";
import { norm } from "./core/paths.mjs";
import { appendAudit } from "./core/store.mjs";

/** Cache guard context per common-dir for a short TTL (git worktree list is not free). */
const CTX_TTL_MS = 10_000;
const ctxCache = new Map(); // commonDir -> { at, ctx }

export async function guardContext(cwd, { protectedBranches } = {}) {
  const cd = gitCommonDirOf(cwd);
  if (!cd) return null;
  const hit = ctxCache.get(cd);
  if (hit && Date.now() - hit.at < CTX_TTL_MS) return { commonDir: cd, ctx: hit.ctx };
  const { mainRoot, entries } = listWorktrees(cwd);
  if (!mainRoot) return null;
  const ctx = {
    mainRoot,
    worktrees: entries.filter((e) => norm(e.root) !== norm(mainRoot) && !e.bare).map((e) => ({ root: e.root, name: worktreeNameOf(e.root) })),
    protectedBranches,
  };
  ctxCache.set(cd, { at: Date.now(), ctx });
  return { commonDir: cd, ctx };
}

const FILE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read", "read_image"]);
const SEARCH_TOOLS = new Set(["glob", "grep"]);
const GATED_TOOLS = new Set(["worktree_authorize_main", "worktree_allow"]); // P4 ask gate

/** Pending post-execute markers keyed by callId (opencode pendingShellRewrites lineage; cap 256). */
const pendingMarks = new Map();
export function takePendingMark(callId) {
  if (!callId) return null;
  const m = pendingMarks.get(callId);
  pendingMarks.delete(callId);
  return m ?? null;
}
function putPendingMark(callId, mark) {
  if (!callId || !mark) return;
  if (pendingMarks.size > 256) pendingMarks.delete(pendingMarks.keys().next().value);
  pendingMarks.set(callId, mark);
}

/**
 * Main entry: decide a pre-execute outcome for one tool call.
 * @param {object} exec tool execution ({ name, arguments, agent })
 * @param {object} opts { protectedBranches, readPolicy, currentBranchName? }
 * @returns {Promise<{kind:"allow"}|{kind:"deny",reason}|{kind:"ask",reason}|{kind:"allow",mark?}>}
 */
export async function decideToolCall(exec, opts = {}) {
  const toolName = exec?.name;
  if (GATED_TOOLS.has(toolName)) {
    return {
      kind: "ask",
      reason: `[worktree-guard] ${toolName} 需要用户确认后才会执行（P4 机械人闸）：请在用户明确同意后调用。`,
    };
  }

  const cwd = exec?.agent?.session?.header?.cwd;
  if (!cwd) return { kind: "allow" }; // no session context -> host semantics only (P1)

  let gc;
  try {
    gc = await guardContext(cwd, { protectedBranches: opts.protectedBranches });
  } catch {
    gc = null; // not a git repo -> nothing to guard
  }
  if (!gc) return { kind: "allow" };

  const { commonDir, ctx } = gc;
  const ident = {
    sessionId: exec.agent.session.header.id,
    parentSession: exec.agent.session.header.parentSession ?? null,
  };
  let binding = null;
  try {
    binding = await resolveBinding(commonDir, ident);
  } catch (err) {
    // fail policy split (design §11): write tools fail-closed (rethrow), read tools fail-open
    if (FILE_TOOLS.has(toolName)) throw err;
    return { kind: "allow" };
  }

  const args = exec.arguments ?? {};
  const baseDir = cwd;

  if (FILE_TOOLS.has(toolName)) {
    const d = decideWrite(args.file_path ?? args.filePath ?? args.path, baseDir, ctx, binding);
    if (d.kind === "deny") await audit(commonDir, ident.sessionId, "deny_write", d.reason, args);
    return d;
  }
  if (READ_TOOLS.has(toolName)) {
    try {
      const d = decideRead(args.file_path ?? args.filePath ?? args.path, baseDir, ctx, binding, { readPolicy: opts.readPolicy });
      if (d.mark) {
        putPendingMark(exec.callId, d.mark);
        await audit(commonDir, ident.sessionId, "read_origin_mark", d.mark, args);
      }
      return d;
    } catch {
      return { kind: "allow" }; // read side fail-open
    }
  }
  if (SEARCH_TOOLS.has(toolName)) {
    try {
      if (typeof args.path !== "string") {
        // no explicit path: search roots at session workspace (structural default) -> allow
        return { kind: "allow" };
      }
      const d = decideRead(args.path, baseDir, ctx, binding, { readPolicy: opts.readPolicy });
      if (d.mark) await audit(commonDir, ident.sessionId, "read_origin_mark", d.mark, args);
      return d;
    } catch {
      return { kind: "allow" };
    }
  }
  if (toolName === "pwsh" || toolName === "bash") {
    try {
      const branchNow = opts.currentBranchName ?? safeCurrentBranch(cwd);
      const d = decidePwsh({ command: args.command, currentBranchName: branchNow }, ctx, binding);
      if (d.kind === "deny") await audit(commonDir, ident.sessionId, "deny_shell", d.reason, args);
      return d;
    } catch (err) {
      // shell net is lexical; a broken net must not brick the session (fail-open + audit)
      await safeAudit(commonDir, ident.sessionId, "shell_guard_error", String(err), args);
      return { kind: "allow" };
    }
  }
  return { kind: "allow" };
}

function safeCurrentBranch(cwd) {
  try {
    return currentBranch(cwd);
  } catch {
    return null;
  }
}

async function audit(commonDir, sessionId, type, detail, args) {
  await appendAudit(commonDir, { type, session: sessionId, detail, tool_args: safePick(args) });
}
async function safeAudit(commonDir, sessionId, type, detail, args) {
  try {
    await audit(commonDir, sessionId, type, detail, args);
  } catch { /* audit must never break the guard */ }
}
function safePick(args) {
  const out = {};
  for (const k of ["file_path", "path", "command"]) if (typeof args?.[k] === "string") out[k] = args[k];
  return out;
}

export { isRooted };
