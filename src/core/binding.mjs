// core/binding.mjs — three-tier binding resolution (design §10):
//   1. own bindings/<session>.json
//   2. lazy parentSession chain walk (native DSH lineage; depth cap 10), snapshot to own file
//   3. null => open (host sandbox semantics; P1)
// Parent ids arrive from the caller (guard passes exec.agent.session.header.parentSession).
import { readBinding, writeBinding } from "./store.mjs";
import { norm } from "./paths.mjs";

export const MAX_LINEAGE_DEPTH = 10;

/**
 * @param {string} commonDir
 * @param {{sessionId: string, parentSession?: string|null}} ident
 * @param {{listParents?: (sid:string)=>string|null}} hooks  injectable for tests
 * @returns {Promise<{worktree:string, branch:string, source:"self"|"inherited", resolved_at:string}|null>}
 */
export async function resolveBinding(commonDir, ident, hooks = {}) {
  const own = await readBinding(commonDir, ident?.sessionId);
  if (own?.worktree) return { ...own, source: "self" };

  const listParents = hooks.listParents ?? (() => null);
  let sid = ident?.parentSession ?? null;
  for (let depth = 0; sid && depth < MAX_LINEAGE_DEPTH; depth++) {
    const b = await readBinding(commonDir, sid);
    if (b?.worktree) {
      const snapshot = {
        worktree: b.worktree,
        branch: b.branch,
        base: b.base,
        inherited_from: sid,
        resolved_at: new Date().toISOString(),
      };
      // Snapshot (never blocks owner — P5: owner's binding file untouched).
      await writeBinding(commonDir, ident.sessionId, { ...snapshot, source: "inherited" });
      return { ...snapshot, source: "inherited" };
    }
    sid = listParents(sid);
  }
  return null;
}

/** Is `cwd` the bound worktree root (rooted session detection)? */
export function isRooted(cwd, binding) {
  return !!binding && norm(cwd) === norm(binding.worktree);
}
