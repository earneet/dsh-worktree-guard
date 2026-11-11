// capabilities.js — where a session ROOT can come from, and what isolation a
// session actually gets when it does not have a copy root (issue #4).
//
// The incident: `worktree_create` recommended "open a new session rooted at the
// copy" and `worktree_enter` refused with the SAME recommendation. On that host
// the GUI offered no entry point for it, so two "next steps" pointed at one
// unreachable action, and the only way left (keep working in this session with
// absolute paths) silently degraded from structural isolation to discipline.
//
// Contracts behind this module (evidence: design-review.md "issue #4"):
//   - a session's write boundary is its `cwd` at creation time
//     (`sandboxPolicy.resolve` -> `workspaceRoot = session.header.cwd`), and the
//     GUI adopts a directory by creating a WORKSPACE and starting a session in
//     it (ui-workspace "Add workspace…" + per-workspace "New session");
//   - the host can MOVE a session's directory (`ctx.workingDirectory.set`).
//     The pre-execute hook cannot rewrite tool args (C1), so the guard can only
//     offer that move as an explicit, user-approved tool action.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { norm, isUnder } from "./paths.js";

/** Provider keys a host build may expose under `ctx.worktrees`. */
export const WORKTREE_SERVICE_KEYS = ["worktrees", "worktree"];

/** The two isolation grades the guard can honestly claim (P6 vocabulary). */
export const ISOLATION_STRUCTURAL = "structural";
export const ISOLATION_DISCIPLINARY = "disciplinary";

/**
 * Write boundary of a sandbox mode: `undefined` = no structural write fence at
 * all (danger-full-access), otherwise the mode is fenced (read-only fences
 * every write; workspace-write fences everything outside the workspace root).
 */
export function structuralFence(mode) {
  if (typeof mode !== "string" || mode === "") return undefined; // unknowable != unsafe
  return mode === "danger-full-access" ? null : mode;
}

/** Human-readable fence sentence for deny/render copy. */
export function fenceLabel(mode) {
  switch (mode) {
    case "danger-full-access":
      return "无写围栏：宿主沙箱不限制任何写入";
    case "workspace-write":
      return "会话根围栏：只有目标副本目录在可写范围内";
    case "read-only":
      return "只读：写操作本身就被沙箱拒绝，切换后也写不进副本";
    default:
      return `沙箱模式未知（${mode ?? "?"}）`;
  }
}

/**
 * Which session-root path can the host actually carry out?
 *   gui-workspace : a directory can be adopted as a workspace and rooted there
 *   cwd-move      : the host can move THIS session (`ctx.workingDirectory.set`)
 *   unavailable   : nothing verifiable — do not claim it works
 */
export function sessionRootPath(caps = {}) {
  if (caps.workspaceRegistry === true) return "gui-workspace";
  if (caps.workingDirectory === true) return "cwd-move";
  return "unavailable";
}

/**
 * Isolation grade a session gets right now (pure). A copy root fenced by the
 * sandbox is structural; anything narrower — no binding, a binding that does not
 * match the session root (reads keep the main world, writes are denied one by
 * one), or a fenced-structure-free sandbox — is disciplinary, because the copy
 * boundary then exists only in the guard's lexical rules.
 */
export function isolationGrade({ mode, binding, cwd } = {}) {
  const fenced = structuralFence(mode);
  if (fenced === null) return ISOLATION_DISCIPLINARY;
  if (!binding) return ISOLATION_DISCIPLINARY;
  // An UNKNOWN mode is not provably unfenced, so a correctly rooted copy keeps
  // the structural grade here (P1: absence of a capability must not widen or
  // narrow the guard's own claims beyond what it can see).
  return norm(cwd) === norm(binding.worktree) ? ISOLATION_STRUCTURAL : ISOLATION_DISCIPLINARY;
}

/** Machine-readable causes for the non-structural grade. */
export function isolationReasons({ mode, binding, cwd, copiesUnbound = false } = {}) {
  const reasons = [];
  if (binding == null || binding === undefined || binding === null) reasons.push("no-binding");
  else if (norm(cwd) !== norm(binding.worktree)) reasons.push("binding-root-mismatch");
  if (structuralFence(mode) === null) reasons.push("sandbox-unfenced");
  if (mode === undefined) reasons.push("sandbox-mode-unknown");
  if (copiesUnbound) reasons.push("unbound-with-copies");
  return reasons;
}

/**
 * Sentence naming the grade; `copiesUnbound` tells the degraded-but-copy-exists
 * case apart (that is the issue-#4 trap: a copy exists, the session is not in
 * it, so nothing the guard says may suggest it is isolated).
 */
export function isolationNote({ grade, mode, copiesUnbound = false } = {}) {
  if (grade === ISOLATION_STRUCTURAL) {
    return `隔离等级：结构（会话根 = 副本，${fenceLabel(mode)}）。`;
  }
  const unfenced = structuralFence(mode) === null
    ? `沙箱 ${mode} ${fenceLabel(mode)}（比副本根更宽，副本边界只剩守卫的词法规则，P6）`
    : copiesUnbound
      ? `存在未绑定的副本，本会话并未在其中（写隔离靠"路径写对"，词法级、可绕，P6）`
      : `本会话不在副本根内（跨根写入是逐次 deny 而非结构隔离，P6）`;
  return `隔离等级：纪律（${unfenced}）。`;
}

/**
 * One executable next step for a session that wants structural isolation but is
 * not in a copy. Each branch is only emitted when its capability was probed.
 */
export function nextIsolationSteps(caps = {}) {
  const path = sessionRootPath(caps);
  const steps = [];
  if (path === "gui-workspace") {
    steps.push(
      "宿主侧新开副本会话（GUI）：「添加工作区…」选中副本目录（或它的上级）→ 在该工作区里新建会话；新会话的写边界就是那次选择的目录。",
    );
    if (caps.workingDirectory !== true) return steps; // no in-session alternative at all
  }
  if (caps.workingDirectory === true) {
    steps.push(
      "会话内切换（写边界不变）：worktree_enter{path, switch_session:true} 让宿主 workingDirectory.set 把本会话目录移进副本；写边界仍按会话创建时的 cwd 计，真结构隔离仍要上一条。",
    );
  } else if (path === "unavailable") {
    steps.push("降级继续（纪律级）：向副本内写文件用绝对路径（相对路径落主 checkout）；读域不受守卫约束，主 checkout 仍在可写范围内。");
  }
  return steps;
}

/** Channel suffix for the DENY path (the guard is blocking something right now). */
export function denyRecoveryText(caps = {}) {
  return `副本会话本身已是结构隔离：${withPathTypedRoute(caps).join(" ")}`;
}

/** Dry-run / otherwise harmless copy can name the fence plainly without skipping. */
export const FENCE_MARKER = "副本写边界不含副本";

/** Deny-path probe line: names the fence and the first reachable route. */
export function fenceRecoveryLine(caps = {}) {
  const first = withPathTypedRoute(caps)[0];
  return first ? `${FENCE_MARKER}（沙箱会拒绝写到副本的绝对路径）——结构隔离只能先让会话根落在副本上：${first}` : null;
}

/**
 * Sessions that already received the fence advice. The copy line above is
 * idempotent (the guard drops it when the deny already says it), so this is
 * only a bound against unbounded growth.
 */
const fenceAdvised = new Set();

/** Remember a session that got the advice (bounded; same cap as other session bookkeeping). */
export function noteFenceAdvice(sessionId, cap = 1000) {
  if (!sessionId) return;
  fenceAdvised.add(sessionId);
  if (fenceAdvised.size > cap) fenceAdvised.delete(fenceAdvised.values().next().value);
}

/**
 * Close-out for the session-start notice: with a FENCED sandbox the copy is
 * outside the write boundary, so "write absolute paths into the copy" would be
 * refused by the sandbox — say that instead of prescribing it.
 */
export function sessionAdvice({ mode } = {}) {
  if (structuralFence(mode) === null) {
    return "在此之前：写文件用指向副本内的绝对路径（相对路径落主 checkout），读域不受守卫约束；沙箱不围栏，主 checkout 仍在可写范围内。";
  }
  return `在此之前：${FENCE_MARKER}，写副本的绝对路径会被沙箱拒绝——相对路径写会让文件落到主 checkout，改写前先确认路径；主 checkout 仍在可写范围内，属纪律级。`;
}

/* ---------- probe seams (the only impure part; host objects only) ---------- */

function svc(get, key) {
  try {
    return typeof get === "function" ? get(key) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Probe what the HOST offers, never what this plugin hopes (C11: an absent
 * capability degrades to "unavailable" instead of an unreachable recommendation).
 * @param {(key: string) => any} get cordis context getter
 * @param {object} [env] test seam { exists?: (p) => Promise<boolean> }
 */
export async function probeHostCapabilities(get, env = {}) {
  const registry = svc(get, "workspaceRegistry");
  // `directoryPicker.pick` opens the native folder dialog — the UI's ability to
  // adopt a folder. No picker => the only remaining route is path-typed creation.
  const picker = svc(get, "directoryPicker");
  const adapter = svc(get, "directoryPickerController");
  const pickerCapable = typeof picker?.capability === "function"
    || picker?.capability !== undefined
    || typeof adapter?.pick === "function";
  const working = svc(get, "workingDirectory");
  const worktrees = WORKTREE_SERVICE_KEYS.map((k) => svc(get, k)).find((s) => s && typeof s.restore === "function") ?? null;
  // Best-effort: does <home>/.dsh/profiles exist (path-typed workspace creation
  // lives behind a plugin command that depends on it)? A failed read only drops
  // the hint, never a capability.
  let profilesDir = false;
  if (!pickerCapable) {
    try {
      const exists = env.exists ?? ((p) => import("node:fs/promises").then((fs) => fs.access(p).then(() => true, () => false)));
      profilesDir = await exists(join(homedir(), ".dsh", "profiles"));
    } catch {
      profilesDir = false;
    }
  }
  return {
    workspaceRegistry: !!registry && typeof registry.create === "function",
    directoryPicker: pickerCapable,
    workingDirectory: !!working && typeof working.set === "function",
    worktreeService: worktrees != null,
    profilesDir,
  };
}

/** Add the path-typed creation route when the workspace registry exists but has no UI picker. */
export function withPathTypedRoute(caps = {}) {
  if (!caps.workspaceRegistry || caps.directoryPicker) return nextIsolationSteps(caps);
  const steps = nextIsolationSteps(caps);
  const hint = caps.profilesDir
    ? "（该路径依赖 profile 目录存在；本宿主上可见于 ~/.dsh/profiles/<profile>。）"
    : "（当前探测不到 <home>/.dsh/profiles，该命令可能不可用。）";
  return [
    `宿主侧路径创建：dsh workspace --profile <profile> create --cwd "<副本目录>" 后，在 Web GUI 里对该工作区新建会话${hint}`,
    ...steps,
  ];
}

/** Extra deny copy for fenced sandboxes: the copy is simply outside the boundary. */
export function fenceDenyHint({ mode, worktree, cwd } = {}) {
  if (structuralFence(mode) === null) return null;
  if (!worktree) return null;
  if (!norm(cwd) || norm(cwd) === "" ) return null;
  if (isUnder(norm(worktree), norm(cwd))) return null;
  return `本会话写边界是 ${cwd} 及其后代，副本 ${worktree} 在边界之外——以绝对路径写副本会被沙箱拒绝，这也是"结构隔离"的本义：先让会话根落在副本上。`;
}

export { dirname };
