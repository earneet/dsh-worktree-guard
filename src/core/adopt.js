// adopt.js — one session path for repositories WITHOUT the host's own worktree
// service (issue #5). The user's objection: requiring "add the copy as a
// workspace and start a new session there" before anything may be bound makes
// the human do the agent's job. The product goal is "the agent works on the
// right branch", not maximal manual ceremony.
//
// Two contracts make the simple design possible (verified against the host and
// against git):
//   1. The host's write boundary is the session's creation cwd, and its sandbox
//      accepts a RELATIVE path that physically resolves inside that boundary
//      (a nested copy `<main>/.worktrees/worktree-x` is inside the main root).
//   2. git's argv never has to name the copy: `bash -c 'cd <copy> && …'` is a
//      no-op relative cd inside the boundary, and `git -C <relative copy>` works
//      from the main root. No shell word ever holds an absolute copy path, so a
//      fenced sandbox cannot refuse the write and the guard still sees the truth.
//
// This module is PURE (no fs/git): guard.js resolves the binding, the tools
// persist it, the shell hooks turn a cwd-relative word into the copy path the
// model meant.
import { relative, isAbsolute } from "node:path";
import { norm, isUnder } from "./paths.js";

/**
 * Binding kinds. `not-copy-rooted` is an ADOPTED binding: the session root is
 * not the copy, so the guard routes the session's work into the copy instead
 * of pretending the sandbox isolates it (P6 vocabulary, see capabilities.js).
 */
export const BINDING_NONE = "none";
export const BINDING_ROOTED = "rooted";
export const BINDING_ADOPTED = "adopted";

function cwdInsideCopy(cwd, worktree) {
  const c = norm(cwd);
  const w = norm(worktree);
  return !!c && !!w && isUnder(c, w);
}

/**
 * Classify the pair (session root, copy) once. `canAdopt` requires the copy to
 * sit inside the session root — the sandbox then accepts a relative path there,
 * which is what makes the channel structural rather than advisory.
 */
export function copyRelation(cwd, worktree) {
  const c = norm(cwd);
  const w = norm(worktree);
  // `inside` = the copy is under the session root (a relative path can reach it)
  const inside = !!c && !!w && isUnder(w, c);
  // `contains` = the session root is the copy or under it (rooted / inside a copy)
  const contains = !!c && !!w && isUnder(c, w);
  // relative() renders with the HOST separator; compare in norm()'s "/" form.
  const rel = inside && c !== w ? relative(c, w).replaceAll("\\", "/") : "";
  return {
    cwd: c,
    worktree: w,
    inside,
    contains,
    rel,
  };
}

/**
 * @param {{binding: object|null, cwd: string|null, caps?: object, entries?: {root:string,prunable?:boolean,locked?:boolean}[]}} input
 * @returns {{
 *   kind: "none"|"rooted"|"adopted"|"stale"|"unadoptable",
 *   worktree: string|null,
 *   needsCwdSwitch: boolean,
 *   adoption: boolean,
 *   reason: string,
 *   rel: string
 * }}
 */
export function resolveBindingMode({ binding, cwd, caps = {}, entries = [] } = {}) {
  if (!binding?.worktree) return { kind: BINDING_NONE, worktree: null, needsCwdSwitch: false, adoption: false, reason: "no-binding", rel: "" };
  const w = norm(binding.worktree);
  const reg = entries.find((e) => norm(e.root) === w);
  const rel = copyRelation(cwd, w);
  if (reg?.prunable) return { kind: "stale", worktree: w, needsCwdSwitch: false, adoption: false, reason: "copy-gone", rel: rel.rel };
  if (rel.contains) return { kind: BINDING_ROOTED, worktree: w, needsCwdSwitch: false, adoption: false, reason: "cwd-in-copy", rel: rel.rel };
  // Issue #5: a copy the host's worktree service owns is restored and entered
  // by the host itself (its create() does exactly that); anything else is
  // adopted in place when the copy lives inside the session boundary.
  const hostManaged = caps?.worktreeService === true;
  const adoptable = !hostManaged && rel.inside;
  return {
    kind: adoptable ? BINDING_ADOPTED : "unadoptable",
    worktree: w,
    needsCwdSwitch: !adoptable,
    adoption: adoptable,
    reason: adoptable ? "copy-inside-root" : hostManaged ? "host-restores-its-own-copies" : "copy-outside-root",
    rel: rel.rel,
  };
}

/**
 * Rewrite ONE shell word that is relative to the session root but names a path
 * inside the copy; `cd <copy>` additionally yields the copy root itself, so
 * `bash -c "cd <copy> && …"` survives as a boundary-safe no-op. Returns null
 * for words that already resolve where the model meant (`.`, paths under the
 * copy, flags, absolute paths).
 */
export function adoptWord(word, mode) {
  if (mode?.kind !== BINDING_ADOPTED || !mode.rel || typeof word !== "string") return null;
  const raw = word.trim();
  if (!raw || raw === "." || raw.startsWith("-") || isAbsolute(raw) || raw.startsWith("~") || raw.startsWith("/")) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null; // URL (git@…/https://…) is not a path
  const relPrefix = mode.rel + "/";
  if (raw === mode.rel) return mode.worktree;
  if (!raw.startsWith(relPrefix)) return null;
  const rest = raw.slice(relPrefix.length);
  if (rest === "" || rest.includes("..")) return null; // never invent escapes
  return `${mode.worktree}/${rest}`;
}

/**
 * Map a tool path argument (write/edit/read → `file_path`, glob/grep → `path`)
 * that is relative to the session root and lands inside the copy onto the copy
 * path. `"."` also maps (a search rooted at the session root means "this
 * session's branch"). Absolute paths and paths that are already under the copy
 * are untouched — the guard's cross-copy rules already see those.
 */
export function adoptPathArg(raw, mode) {
  if (mode?.kind !== BINDING_ADOPTED || typeof raw !== "string") return raw;
  // a model may spell Windows separators; compare in the "/" form
  const rawTrim = raw.trim().replaceAll("\\", "/");
  if (rawTrim === "" || rawTrim === ".") return mode.worktree;
  if (isAbsolute(rawTrim) || rawTrim.startsWith("~") || rawTrim.startsWith("/") || /^[a-zA-Z]:/.test(rawTrim)) return raw;
  const relPrefix = mode.rel + "/";
  if (rawTrim === mode.rel) return mode.worktree;
  if (rawTrim.startsWith(relPrefix)) {
    const rest = rawTrim.slice(relPrefix.length);
    if (rest === "" || rest.includes("..")) return raw;
    return `${mode.worktree}/${rest}`;
  }
  return raw;
}
