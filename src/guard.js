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
import { decideWrite, decideRead, decidePwsh, makeContext, extractGitRetargets } from "./core/decision.js";
import { resolveBinding } from "./core/binding.js";
import { commonDir as gitCommonDirOf, listWorktrees, currentBranch, worktreeNameOf } from "./core/gitops.js";
import { norm, physicalAncestorKey, classifyTarget, extractAbsolutePaths, extractQuotedAbsolutePaths, isUnder } from "./core/paths.js";
import { appendAudit, readState, readAllowlist, authorizeValid } from "./core/store.js";
import { loadSidecar } from "./core/sidecar.js";
import { GUARD_CTX_TTL_MS, DEFAULT_PROTECTED_BRANCHES } from "./core/constants.js";
import { manualOrCliHint, humanChannelHint } from "./core/cli-path.js";
import { structuralFence, fenceRecoveryLine, FENCE_MARKER } from "./core/capabilities.js";
import { resolveBindingMode, adoptWord, BINDING_ADOPTED } from "./core/adopt.js";
import { access } from "node:fs/promises";

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
 * ROOTED sessions under danger-full-access lose the structural layer entirely,
 * so the guard denies with an explicit warning instead of silently degrading
 * (design §11). ADOPTED sessions are exempt (live-T3 finding, 0.2.4): adoption
 * claims nothing structural — its grade is already disciplinary (P6) — so a
 * blanket deny would brick the session without adding any protection; the
 * routing (copy-prefixed writes, cross-copy denials) keeps working exactly as
 * documented.
 */
async function sandboxDenied(binding, opts, header) {
  if (!binding || typeof opts?.sandboxModeOf !== "function") return null;
  let mode;
  try {
    mode = await opts.sandboxModeOf(header); // may be sync or async (host-dependent)
  } catch {
    return null; // capability probe failure -> lexical net continues (P1)
  }
  if (mode === "danger-full-access" && binding.mode !== "adopted") {
    return {
      kind: "deny",
      reason: `[worktree-guard] 已阻止工具调用。\n原因：会话沙箱处于 danger-full-access，为防结构性绕过，绑定会话（${binding.worktree}）在此模式下所有非 worktree_* 工具均被拒绝（采用模式绑定除外：它本就是纪律级路由）。\n下一步：将沙箱模式切回 workspace-write 后继续；确需全权操作请先调用 worktree_exit 解绑。`,
    };
  }
  return null;
}

/**
 * Issue #4 on the DENY path — now scoped to what is actually true: a fenced
 * sandbox refuses an absolute-path write ONLY when the denied target lies
 * OUTSIDE the session write boundary. A nested copy (the default layout) is
 * inside it, so for those the adoption route (issue #5) is the advice; this
 * line fires only for a copy the session genuinely cannot reach.
 */
async function fenceAdvice(effOpts, header, target, denyReason, mode) {
  if (!effOpts?.hostCapabilitiesOf || typeof effOpts.sandboxModeOf !== "function") return null;
  if (!target || !header?.cwd) return null;
  // adoption already routes the work into the copy; the deny is about something
  // else, and "outside your boundary" advice about the copy would be wrong.
  if (mode?.kind === BINDING_ADOPTED) return null;
  let caps;
  try {
    caps = await effOpts.hostCapabilitiesOf(header);
  } catch {
    return null;
  }
  // claim sandbox behaviour only when the fenced mode was actually probed
  const fence = structuralFence(caps?.sandboxMode);
  if (fence === null || fence === undefined) return null;
  if (isUnder(norm(target), norm(header.cwd))) return null; // inside the boundary
  if (String(denyReason ?? "").includes(FENCE_MARKER)) return null;
  return fenceRecoveryLine(caps);
}

/**
 * Paths referenced by a shell command that do NOT exist (issue #2). The
 * decision tables stay fs-free; this probe only sharpens deny copy (a missing
 * copy path is not "the main checkout"), so a stat failure must never change
 * allow/deny by itself. Only repo-local paths matter (rule 4's "main" branch),
 * which also bounds the fs probes to the checkout instead of touching arbitrary
 * network paths that merely appear in an argument.
 */
async function missingPathSet(command, cwd, mainRoot) {
  if (typeof command !== "string") return new Set();
  const root = norm(mainRoot);
  const candidates = new Set(extractAbsolutePaths(command));
  for (const p of extractQuotedAbsolutePaths(command)) candidates.add(p);
  for (const t of extractGitRetargets(command)) {
    try { candidates.add(norm(t, cwd)); } catch { /* lexical fallback below */ }
  }
  const missing = new Set();
  for (const p of candidates) {
    const abs = norm(p);
    if (!abs || !isUnder(abs, root)) continue;
    try { await access(abs); } catch { missing.add(abs); }
  }
  return missing;
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
    // issue #4 deny copy: which session-root routes this host really offers
    hostCapabilitiesOf: opts.hostCapabilitiesOf,
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

  // Issue #5: a session that adopted a copy it cannot root itself in works in
  // the copy through boundary-safe relative paths. `mode` drives every seam
  // below; `binding` (the copy) is what the decision tables already understand.
  let caps = null;
  const capsOf = async () => {
    if (caps) return caps;
    if (typeof effOpts.hostCapabilitiesOf !== "function") return (caps = {});
    caps = (await effOpts.hostCapabilitiesOf(header).catch(() => ({}))) ?? {};
    return caps;
  };
  const mode = resolveBindingMode({ binding, cwd, caps: opts?.hostCapabilitiesOf ? await capsOf() : {}, entries: ctx.worktrees });

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
    let cls0 = classifyTarget({ target, mainRoot: ctx.mainRoot, worktrees: ctx.worktrees, commonDir: ctx.commonDir });
    if (cls0.kind === "main") {
      const fresh = await guardContext(cwd, { ...effOpts, force: true }).catch(() => null);
      if (fresh) {
        ({ commonDir, ctx } = fresh);
        cls0 = classifyTarget({ target, mainRoot: ctx.mainRoot, worktrees: ctx.worktrees, commonDir: ctx.commonDir });
      }
    }
    const d = decideWrite(target, baseDir, ctx, binding, await loadAuth(commonDir, ctx.mainRoot));
    if (d.kind === "deny") {
      // the fence line is only honest for a COPY the session cannot reach
      const fence = cls0.kind === "worktree" ? await fenceAdvice(effOpts, header, target, d.reason, mode).catch(() => null) : null;
      if (fence) d.reason = `${d.reason}\n${fence}`;
      // Issue #5: an adopted session that aimed a session-relative path at the
      // main checkout gets the copy-prefixed retry path — one turn, executable,
      // and the sandbox accepts it (the copy sits inside the write boundary).
      else if (mode.kind === BINDING_ADOPTED && cls0.kind === "main") {
        const rel = target.startsWith(`${norm(ctx.mainRoot)}/`) ? target.slice(norm(ctx.mainRoot).length + 1) : "";
        if (rel) d.reason += `\n采用模式：本会话已绑定副本 ${mode.worktree}（分支 ${binding.branch ?? "?"}）——重试用 ${mode.rel}/${rel}（或绝对路径 ${mode.worktree}/${rel}），文件就会落在副本分支上。`;
      }
      await safeAudit(commonDir, ident.sessionId, "deny_write", d.reason, args);
    }
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
      // issue #2: existence is probed here (guard), never inside the pure
      // decision tables, and only feeds deny copy.
      const missingPaths = await missingPathSet(args.command, cwd, ctx.mainRoot).catch(() => new Set());
      // Issue #5: the word-level adoption seam. Only boundary-safe rewrites
      // (relative → the copy it already names, `cd <copy>` → itself) are added;
      // a rewrite that cannot be done safely means the REAL string is decided.
      const rewritten = mode.kind === BINDING_ADOPTED ? adoptShellWords(args.command, mode) : null;
      d = decidePwsh({ command: rewritten?.command ?? args.command, currentBranchName: branchNow, cwd, missingPaths }, ctx, binding, await loadAuth(commonDir, ctx.mainRoot));
      if (rewritten?.adopted && d.kind !== "deny") {
        // P3: the model's relative copy word was read against the copy; say so.
        d.mark = `[worktree-guard] 采用模式：${rewritten.note}（工作落在副本 ${binding.branch ?? "?"} 上）。`;
      }
    } catch (err) {
      // a broken net must not brick the session: fail-open + audit (§11)
      await safeAudit(commonDir, ident.sessionId, "shell_guard_error", String(err), args);
      return { kind: "allow" };
    }
    if (d.kind === "deny") {
      await safeAudit(commonDir, ident.sessionId, "deny_shell", d.reason, args);
      return d;
    }
    if (d.mark) putPendingMark(exec.callId, d.mark);
    // 0.2.3 (issue #1): the relaxed protected-push path is audited; the audit
    // record is the deviation trace (P3), the host still sees a plain allow.
    if (d.audit) {
      await safeAudit(commonDir, ident.sessionId, d.audit, "未绑定会话根在主 checkout，推送当前受保护分支", args);
    }
    return { kind: "allow" };
  }
  return { kind: "allow" };
}

/**
 * Issue #5 word-level seam for adopted sessions: turn relative copy words into
 * the copy path the model meant (see core/adopt.js). Every other byte of the
 * command is left alone; no match returns null (the pristine string decides).
 */
function adoptShellWords(command, mode) {
  if (mode?.kind !== BINDING_ADOPTED || typeof command !== "string" || !command) return null;
  let adopted = 0;
  let note = "";
  const out = command.replace(/(^|[\s"'`;|&(])([^\s"'`;|&()<>]+)/g, (whole, lead, word) => {
    const mapped = adoptWord(word, mode);
    if (!mapped) return whole;
    adopted += 1;
    note = mapped === mode.worktree ? "cd 副本根" : "相对路径 → 副本内";
    return lead + mapped;
  });
  return adopted ? { command: out, adopted, note } : null;
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
