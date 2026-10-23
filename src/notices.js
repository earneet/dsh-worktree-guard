// notices.js — the five communication channels to the model (standing line,
// session-start inject, deny messages, tool descriptions, read markers).
// Component D in the design doc (§7). Channel budgets are frozen by contract:
// standing line = 1 line, session-start inject <= 15 lines, deny = 3 parts,
// markers = 1 line. P7: no user files.
import { resolveBinding, isRooted } from "./core/binding.js";
import { commonDir, worktreeNameOf } from "./core/gitops.js";
import { readState } from "./core/store.js";
import { readOriginMark as coreReadOriginMark } from "./core/decision.js";
import { STALE_THRESHOLD_MS } from "./core/constants.js";

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
export async function sessionStartText({ cwd, sessionId, parentSession = null }) {
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
  if (!binding) {
    const st = await readState(cd);
    const last = st?.last_active ? Date.parse(st.last_active) : NaN;
    // informational only if the last copy activity is stale, not merely recent
    if (Number.isFinite(last) && Date.now() - last > STALE_THRESHOLD_MS) {
      return `${PREFIX} 上会话副本长期未收尾（${st.last_active}）：调 worktree_status 盘点，将未收尾副本与清理建议报告用户。`;
    }
  }
  return null;
}

/** Channel 5 — read-domain origin marker (1 line; warn mode). Delegates to core. */
export const readOriginMark = coreReadOriginMark;
