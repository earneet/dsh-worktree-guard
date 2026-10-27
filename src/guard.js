// guard.js — the tools/pre-execute safety net for writes, reads, and shells
// (component A/A' in the design doc, §4). deny-only by contract (DSH cannot
// rewrite args — contract C1); ask-gate for authorize/allow tools (P4), with a
// policy probe that turns a guaranteed-to-fail ask into an actionable deny when
// the session's approval policy is "never" (round-13).
// Fail policy (§11): a throw here is fail-closed for free (host waterfall
// catches -> tool error). Read-side and shell-side judgments self-catch to
// fail-open — but a DENY decision already reached is returned regardless of
// audit failures (audit must never weaken the net; adversarial round-1
// blocker fix).
import { decideWrite, decideRead, decidePwsh, makeContext } from "./core/decision.js";
import { resolveBinding } from "./core/binding.js";
import { commonDir as gitCommonDirOf, listWorktrees, currentBranch, worktreeNameOf } from "./core/gitops.js";
import { norm, physicalAncestorKey, classifyTarget } from "./core/paths.js";
import { appendAudit, readState, readAllowlist, authorizeValid } from "./core/store.js";
import { loadSidecar } from "./core/sidecar.js";
import { GUARD_CTX_TTL_MS, DEFAULT_PROTECTED_BRANCHES } from "./core/constants.js";
import { manualOrCliHint, humanChannelHint } from "./core/cli-path.js";

const ctxCache = new Map(); // commonDir -> { at, ctx }

/** Bust the cache after lifecycle operations that change the worktree set. */
export function bustGuardContextCache() {
  ctxCache.clear();
}

/**
 * Guard context per repo. `force` bypasses the TTL cache — used to close the
 * shell-created-worktree misclassification window (round-5 B6): a write whose
 * lexical class is "main" is re-checked against a FRESH worktree list before
 * the always-on cross-copy rule can be fooled by a copy created seconds ago.
 */
export async function guardContext(cwd, { protectedBranches, branchPrefix, force = false } = {}) {
  const cd = await gitCommonDirOf(cwd);
  const hit = ctxCache.get(cd);
  if (!force && hit && Date.now() - hit.at < GUARD_CTX_TTL_MS) return { commonDir: cd, ctx: hit.ctx };
  const { mainRoot, entries } = await listWorktrees(cwd);
  if (!mainRoot) return null;
  // built via makeContext — the SAME assembler tests use (round-6: the
  // hand-built ctx had dropped commonDir, killing the state-area deny under
  // bare layouts). Never fork production/test context shapes.
  const ctx = makeContext({
    mainRoot,
    commonDir: cd,
    worktrees: entries.filter((e) => norm(e.root) !== norm(mainRoot) && !e.bare).map((e) => ({ root: e.root, name: worktreeNameOf(e.root) })),
    protectedBranches,
    branchPrefix,
  });
  ctxCache.set(cd, { at: Date.now(), ctx });
  return { commonDir: cd, ctx };
}

const FILE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read", "read_image"]);
const SEARCH_TOOLS = new Set(["glob", "grep"]);
const SHELL_TOOLS = new Set(["pwsh", "bash"]);
const GATED_TOOLS = new Set(["worktree_authorize_main", "worktree_allow"]); // P4 ask gate

/** Who owns the ask gate (used by index.js to probe policy only for these). */
export function isGatedTool(name) {
  return GATED_TOOLS.has(name);
}

/**
 * Read the session's EFFECTIVE approval policy when the host exposes its
 * approval service (capability probe, C11): `overrideOf(session)` is the last
 * logged `approval/policy`, else the service config default. Absent/unknown =>
 * undefined and the old ask path stays (the host owns that messaging).
 */
async function approvalPolicyOf(session, opts) {
  if (!session?.header || typeof opts?.approvalPolicyOf !== "function") return undefined;
  try {
    const policy = await opts.approvalPolicyOf(session);
    return typeof policy === "string" ? policy : undefined;
  } catch {
    return undefined; // probe failure must never change the ask path
  }
}

/**
 * With approval policy "never" the host rejects the ask deterministically
 * BEFORE any answerer runs — the user never sees a prompt while the model sees
 * `the user rejected tool` (round-13 live finding; incident session had
 * switched to the danger-full-access preset, which bundles approval=never).
 * Returning deny with the human-channel fallback stops the retry loop.
 */
// The human-channel copy lives in ONE place (cli-path.js) so decision.js and
// guard.js cannot drift; only the tool-specific fallback branch differs.
function humanFallback(toolName) {
  return toolName === "worktree_allow"
    ? `请用户切换到会弹确认的权限预设后重试，或由用户自行在目标仓库的 .dsh/worktree-guard.json 中配置 main_write_whitelist（等价放行；glob 全匹配，如 "docs/*"）；插件不代写用户配置。`
    : `${manualOrCliHint()}；也可切换会弹确认的权限预设后重试。`;
}

export function gateUnavailableReason(toolName) {
  return {
    kind: "deny",
    reason: `[worktree-guard] 已阻止 ${toolName}：本会话审批提示被禁用（approval=never），ask 门必然被宿主自动拒绝。\n原因：审批请求在到达用户界面前就被确定拒绝——会话内没有可用的真人确认通道（常由 danger-full-access 权限预设带来）。\n下一步：${humanFallback(toolName)}`,
  };
}

// Host outcome vocabulary: policy "never" collapses into "rejected" and the
// no-answerer case into "no approval channel is available" (dsh-tools).
const GATE_REJECTION_RE = /rejected tool|rejected by user|no approval channel is available|approval .*cancelled/i;

/**
 * post-execute advisory for gated tools the host refused. The error text alone
 * cannot distinguish "the user declined" from "no prompt was ever shown", so
 * the marker names both, using the effective policy (re-probed by index.js) to
 * pick the precise cause, and points at the per-tool human channel (P3:
 * deviations visible; issue suggestions #1/#5).
 */
export function gateRejectionMark(exec, result, policy) {
  if (!GATED_TOOLS.has(exec?.name) || !result?.isError) return null;
  const text = String(result?.error?.message ?? result?.content?.[0]?.text ?? "");
  if (!GATE_REJECTION_RE.test(text)) return null;
  const cause = policy === "never"
    ? `审批提示被禁用（approval=never）时宿主不弹框、直接返回 "the user rejected tool"。`
    : `宿主返回了拒绝，但未必是用户反悔——也可能是审批通道不可用（无应答者或策略在调用间切换）。`;
  return `[worktree-guard] 授权工具被宿主拒绝，不一定是用户拒绝：${cause}不要立即重复调用；${humanFallback(exec.name)}`;
}

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
 * P4 grant state consumed by the decision tables (never wider than host sandbox).
 * Merges the sidecar's main_write_whitelist glob patterns (§13).
 */
async function loadAuth(commonDir, mainRoot) {
  try {
    const [state, allowlist, sidecar] = await Promise.all([readState(commonDir), readAllowlist(commonDir), loadSidecar(mainRoot)]);
    // whitelist patterns are repo-relative -> resolve against mainRoot once
    const { join: pjoin, isAbsolute } = await import("node:path");
    const whitelist = (Array.isArray(sidecar?.mainWriteWhitelist) ? sidecar.mainWriteWhitelist : [])
      .filter((p) => typeof p === "string" && p.trim() !== "")
      .map((p) => (isAbsolute(p) ? norm(p) : norm(pjoin(mainRoot, p))));
    return {
      authorize: authorizeValid(state),
      allowlist: allowlist?.entries ?? {},
      whitelist,
    };
  } catch {
    return { whitelist: [] }; // fail-tight: no grant readable => no grant applied
  }
}

/**
 * Sandbox linkage (C9, defensive): `opts.sandboxModeOf(header)` is supplied
 * by index.js when the host exposes the capability; absence => no-op.
 * Bound sessions under danger-full-access lose the structural layer entirely,
 * so the guard denies with an explicit warning instead of silently degrading
 * (design §11).
 */
async function sandboxDenied(binding, opts, header) {
  if (!binding || typeof opts?.sandboxModeOf !== "function") return null;
  let mode;
  try {
    mode = await opts.sandboxModeOf(header); // may be sync or async (host-dependent)
  } catch {
    return null; // capability probe failure -> lexical net continues (P1)
  }
  if (mode === "danger-full-access") {
    return {
      kind: "deny",
      reason: `[worktree-guard] 已阻止工具调用。\n原因：会话沙箱处于 danger-full-access，为防结构性绕过，绑定会话（${binding.worktree}）在此模式下所有非 worktree_* 工具均被拒绝。\n下一步：将沙箱模式切回 workspace-write 后继续；确需全权操作请先调用 worktree_exit 解绑。`,
    };
  }
  return null;
}

/**
 * Main entry: decide a pre-execute outcome for one tool call.
 * @param {object} exec tool execution ({ name, arguments, callId, agent })
 * @param {object} opts { protectedBranches, readPolicy, branchPrefix, sandboxModeOf }
 */
export async function decideToolCall(exec, opts = {}) {
  const toolName = exec?.name;
  if (GATED_TOOLS.has(toolName)) {
    // capability probe first: a "never" session has no answerer by design, so
    // asking would guarantee the misleading host rejection (round-13).
    const session = exec?.agent?.session;
    if ((await approvalPolicyOf(session, opts)) === "never") return gateUnavailableReason(toolName);
    return {
      kind: "ask",
      reason: `[worktree-guard] ${toolName} 已挂起，等待用户在界面上确认。仅在用户本轮明确同意后调用；每次调用都会再次询问用户。若本会话审批提示被禁用，宿主会直接自动拒绝——此时不要重复调用，改用人工通道：${humanChannelHint()}。`,
    };
  }

  const header = exec?.agent?.session?.header;
  const cwd = header?.cwd;
  if (!cwd) return { kind: "allow" }; // no session context -> host semantics only (P1)

  // Defaults are unioned in BEFORE the first context build: a plugin Config that
  // overrides protectedBranches must not drop master/main from the push net
  // (P1; round-13 audit: defaults were lost when no sidecar branch keys existed).
  const baseProt = [...new Set([...DEFAULT_PROTECTED_BRANCHES, ...(Array.isArray(opts.protectedBranches) ? opts.protectedBranches : [])])];
  let gc;
  try {
    gc = await guardContext(cwd, { ...opts, protectedBranches: baseProt });
  } catch {
    gc = null; // not a git repo -> nothing to guard
  }
  if (!gc) return { kind: "allow" };

  // sidecar merge (round-5 B1): repo-level config lives at the MAIN ROOT (a
  // rooted session's cwd is the copy, whose .dsh has no sidecar). Config may
  // ADD protected branches but never REMOVE the defaults/plugin set: the push
  // net is monotonic (P1), otherwise a sidecar edit would disable the only
  // guard on a network operation (round-13 audit finding).
  const sidecar = await loadSidecar(gc.ctx.mainRoot).catch(() => ({}));
  const sideProt = Array.isArray(sidecar.protectedBranches) ? sidecar.protectedBranches : [];
  const protectedBranches = [...new Set([...baseProt, ...sideProt].filter((s) => typeof s === "string" && s.trim() !== ""))];
  const effOpts = {
    protectedBranches,
    readPolicy: sidecar.readPolicy ?? opts.readPolicy,
    branchPrefix: sidecar.branchPrefix ?? opts.branchPrefix,
    sandboxModeOf: opts.sandboxModeOf,
  };
  // rebuild the context when sidecar values affect it (protectedBranches feeds
  // the push net, branchPrefix feeds the branch-token net)
  if (sidecar.branchPrefix !== undefined || sidecar.protectedBranches !== undefined) {
    gc = (await guardContext(cwd, { ...effOpts, force: true }).catch(() => gc)) ?? gc;
  }
  let { commonDir, ctx } = gc; // B6 force-refresh below may reassign

  const ident = {
    sessionId: header.id,
    parentSession: header.parentSession ?? null,
  };

  let binding = null;
  try {
    binding = await resolveBinding(commonDir, ident);
  } catch (err) {
    // Fail-policy split: write tools fail-closed (rethrow), read tools
    // fail-open — a broken read net must not blind the session (§11).
    if (FILE_TOOLS.has(toolName)) throw err;
    return { kind: "allow" };
  }

  // C9: bound + danger-full-access -> deny with guidance (§11). Lifecycle
  // tools (worktree_*) are exempt — P5: the escape hatch must never be blocked
  // by the very guard the session needs to escape from.
  const sd = !String(toolName ?? "").startsWith("worktree_") ? await sandboxDenied(binding, effOpts, header) : null;
  if (sd) {
    await safeAudit(commonDir, ident.sessionId, "deny_sandbox_mode", sd.reason, {});
    return sd;
  }

  const args = exec.arguments ?? {};
  const baseDir = cwd;

  if (FILE_TOOLS.has(toolName)) {
    const raw = args.file_path ?? args.filePath ?? args.path;
    // physical (realpath) identity — defeats junction/8.3 aliases for BOTH the
    // existing-target case and NEW files written THROUGH a junction (round-2 #5).
    let target = norm(raw, baseDir);
    if (target) {
      try {
        target = await physicalAncestorKey(target);
      } catch { /* keep lexical */ }
    }
    // B6: a target classified "main" may be a copy created seconds ago via shell
    // (ctx cache is 2s stale) — re-check against a fresh worktree list.
    if (classifyTarget({ target, mainRoot: ctx.mainRoot, worktrees: ctx.worktrees, commonDir: ctx.commonDir }).kind === "main") {
      const fresh = await guardContext(cwd, { ...effOpts, force: true }).catch(() => null);
      if (fresh) ({ commonDir, ctx } = fresh);
    }
    const d = decideWrite(target, baseDir, ctx, binding, await loadAuth(commonDir, ctx.mainRoot));
    if (d.kind === "deny") await safeAudit(commonDir, ident.sessionId, "deny_write", d.reason, args);
    return d;
  }
  if (READ_TOOLS.has(toolName) || SEARCH_TOOLS.has(toolName)) {
    try {
      // searches without an explicit path root at the session workspace — structural
      const raw = READ_TOOLS.has(toolName)
        ? args.file_path ?? args.filePath ?? args.path
        : typeof args.path === "string" ? args.path : null;
      if (raw === null || raw === undefined) return { kind: "allow" };
      const d = decideRead(raw, baseDir, ctx, binding, { readPolicy: effOpts.readPolicy });
      if (d.mark) putPendingMark(exec.callId, d.mark);
      await safeAudit(commonDir, ident.sessionId, "read_origin_mark", d.mark, args);
      return d;
    } catch {
      return { kind: "allow" }; // read side fail-open
    }
  }
  if (SHELL_TOOLS.has(toolName)) {
    // Decision FIRST (outside try), audit AFTER — audit failure must never
    // flip a deny into allow (round-1 blocker fix).
    let d;
    try {
      const branchNow = await currentBranch(cwd).catch(() => null);
      d = decidePwsh({ command: args.command, currentBranchName: branchNow }, ctx, binding, await loadAuth(commonDir, ctx.mainRoot));
    } catch (err) {
      // a broken net must not brick the session: fail-open + audit (§11)
      await safeAudit(commonDir, ident.sessionId, "shell_guard_error", String(err), args);
      return { kind: "allow" };
    }
    if (d.kind === "deny") await safeAudit(commonDir, ident.sessionId, "deny_shell", d.reason, args);
    return d;
  }
  return { kind: "allow" };
}

async function safeAudit(commonDir, sessionId, type, detail, args) {
  try {
    await appendAudit(commonDir, { type, session: sessionId, detail, tool_args: safePick(args) });
  } catch { /* audit must never break the guard (and never weaken a deny) */ }
}
function safePick(args) {
  const out = {};
  for (const k of ["file_path", "path", "command"]) if (typeof args?.[k] === "string") out[k] = args[k];
  return out;
}
