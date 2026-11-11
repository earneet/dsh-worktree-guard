// notices.js — the five communication channels to the model (standing line,
// session-start inject, deny messages, tool descriptions, read markers).
// Component D in the design doc (§7). Channel budgets are frozen by contract:
// standing line = 1 line, session-start inject <= 15 lines, deny = 3 parts,
// markers = 1 line. P7: no user files.
import { resolveBinding, isRooted } from "./core/binding.js";
import { commonDir, listWorktrees, worktreeNameOf } from "./core/gitops.js";
import { readState } from "./core/store.js";
import { readOriginMark as coreReadOriginMark } from "./core/decision.js";
import { STALE_THRESHOLD_MS } from "./core/constants.js";
import { isolationGrade, isolationNote, withPathTypedRoute, sessionAdvice } from "./core/capabilities.js";
import { norm } from "./core/paths.js";

export const PREFIX = "[worktree-guard]";

/** Channel 2 — standing runtime-context line (bound sessions only; 1 line). */
export function standingLine(binding) {
  return `${PREFIX} 本会话锚定 worktree 副本 ${worktreeNameOf(binding.worktree)}（分支 ${binding.branch ?? "?"}）。读写均以本目录为基准；主 checkout 与其他副本的路径会被拦截/标注。`;
}

/**
 * Channel 3 — session-start inject (<=15 lines, information-only when relevant).
 * parentSession is honored (round-5 B2): inherited bindings get the rooted
 * guidance too. The stale hint fires only past the stale threshold — a fresh
 * create/enter must not nag the NEXT main-rooted session (§7 ②).
 */
export async function sessionStartText({ cwd, sessionId, parentSession = null, hostCaps = {}, sandboxMode } = {}) {
  let cd;
  try {
    cd = await commonDir(cwd);
  } catch {
    return null; // not a repo -> zero injection (P1)
  }
  const binding = await resolveBinding(cd, { sessionId, parentSession }).catch(() => null);
  if (binding && isRooted(cwd, binding)) {
    return [
      `${PREFIX} 本会话根是 worktree 副本（分支 ${binding.branch ?? "?"}；主 checkout 与其他副本勿写）。`,
      `守则：读写路径必须解析到本副本内（本目录即根）；合并/push 主干须经用户授权工具，不要直接 git push/checkout 主干。`,
      `任务背景：见 .dsh/task-brief.md。收尾：worktree_status（合并证明+清理步骤）→ 用户同意后 worktree_authorize_main 合并回主干 → worktree_exit remove 清理 → 完成。`,
    ].join("\n");
  }
  // Issue #4: "a copy exists but this session is not in it" is exactly the case
  // where the model used to assume structural isolation. Say the grade and the
  // routes this host actually has, bounded to 3 extra lines.
  if (!binding) {
    let copies = 0;
    try {
      const { mainRoot, entries } = await listWorktrees(cwd);
      copies = entries.filter((e) => !e.bare && norm(e.root) !== norm(mainRoot ?? "")).length;
    } catch { /* no inventory -> no degraded hint */ }
    if (copies > 0) {
      const grade = isolationGrade({ mode: sandboxMode, binding: null, cwd });
      return [
        `${PREFIX} 存在 ${copies} 个 worktree 副本，但本会话不在副本根内：${isolationNote({ grade, mode: sandboxMode, copiesUnbound: true })}`,
        `下一步（按本宿主实际能力）：${withPathTypedRoute(hostCaps).join(" ")}`,
        sessionAdvice({ mode: sandboxMode }),
      ].join("\n");
    }
  }
  if (!binding) {
    const st = await readState(cd);
    // updated_at is an ISO timestamp; last_active is a PATH (Date.parse(path)
    // was always NaN, so this hint never fired since v0.1).
    const last = st?.updated_at ? Date.parse(st.updated_at) : NaN;
    // informational only if the last copy activity is stale, not merely recent
    if (st?.last_active && Number.isFinite(last) && Date.now() - last > STALE_THRESHOLD_MS) {
      return `${PREFIX} 上会话副本长期未收尾（${st.last_active}）：调 worktree_status 盘点绑定；过期记录随后用 worktree_prune 回收。`;
    }
  }
  return null;
}

/** Channel 5 — read-domain origin marker (1 line; warn mode). Delegates to core. */
export const readOriginMark = coreReadOriginMark;
