// notices.mjs — component D (design §7): the five communication channels.
// Channel budgets are frozen by contract: standing line = 1 line, session-start
// inject <= 15 lines, deny = 3 parts, markers = 1 line. P7: no user files.
import { resolveBinding, isRooted } from "./core/binding.mjs";
import { commonDir, currentBranch } from "./core/gitops.mjs";
import { readState, authorizeValid } from "./core/store.mjs";

export const PREFIX = "[worktree-guard]";

/** Channel 2 — standing runtime-context line (bound sessions only; 1 line). */
export function standingLine(binding) {
  return `${PREFIX} 本会话锚定 worktree 副本 ${nameOf(binding.worktree)}（分支 ${binding.branch ?? "?"}）。读写均以本目录为基准；主 checkout 与其他副本的路径会被拦截/标注。`;
}

/** Channel 3 — session-start inject (<=15 lines, information-only when relevant). */
export async function sessionStartText({ cwd, sessionId }) {
  let cd;
  try {
    cd = commonDir(cwd);
  } catch {
    return null; // not a repo -> zero injection (P1)
  }
  const binding = await resolveBinding(cd, { sessionId }).catch(() => null);
  if (binding && isRooted(cwd, binding)) {
    return [
      `${PREFIX} 本会话根是 worktree 副本（分支 ${binding.branch ?? "?"}；主 checkout 与其他副本勿写）。`,
      `守则：读写一律用相对路径（本目录即根）；收尾前不要写主 checkout / 其他副本。`,
      `任务背景：见 .dsh/task-brief.md。收尾：worktree_status（给出已合并证明与清理步骤）→ 用户授权 → 完成。`,
    ].join("\n");
  }
  if (!binding) {
    const st = await readState(cd);
    if (st?.last_active) {
      return `${PREFIX} 上会话副本未收尾（${st.last_active}）：调 worktree_status 盘点。`;
    }
  }
  return null;
}

/** Channel 5 — read-domain origin marker (1 line; warn mode). */
export function readOriginMark(binding) {
  return `${PREFIX} 该读取来自主 checkout（非绑定副本 ${binding.worktree}）——内容是主干世界，勿据其判断副本代码现状。`;
}

function nameOf(root) {
  const parts = String(root).replaceAll("\\", "/").split("/");
  return parts[parts.length - 1] || root;
}
