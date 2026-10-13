// core/paths.mjs — path normalization & classification (Windows-first).
// Ported from opencode-worktree-isolation norm() lineage, hardened per
// adversarial review: strip \\?\ prefixes BEFORE resolve, unify separators,
// case-fold on win32, and classify targets against main/other-worktree/.git.
import { isAbsolute, resolve, join, dirname } from "node:path";
import { platform } from "node:os";
import { execFileSync } from "node:child_process";
import { statSync, readFileSync } from "node:fs";

const IS_WIN = platform() === "win32";

/** Strip Windows extended-length prefixes (\\?\ and \\?\UNC\) before resolve. */
export function stripExtendedLengthPrefix(p) {
  if (typeof p !== "string") return p;
  if (p.startsWith("\\\\?\\UNC\\")) return "\\\\" + p.slice(8);
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

/**
 * Canonical comparable form: resolve against `base` (defaults to cwd),
 * forward slashes, lowercase on win32. NOT a realpath — use
 * `physicalKey()` when canonical identity must survive junction/8.3 aliases.
 */
export function norm(p, base) {
  if (typeof p !== "string" || p === "") return "";
  const stripped = stripExtendedLengthPrefix(p);
  const abs = isAbsolute(stripped) ? stripped : resolve(base ?? process.cwd(), stripped);
  const unified = abs.replaceAll("\\", "/");
  return IS_WIN ? unified.toLowerCase() : unified;
}

/** Realpath-based identity for containment decisions (lexical guard hardening). */
export async function physicalKey(p) {
  const { realpath } = await import("node:fs/promises");
  try {
    return norm(await realpath(stripExtendedLengthPrefix(p)));
  } catch {
    return norm(p); // target may not exist yet — lexical fallback
  }
}

/**
 * Physical identity for possibly-nonexistent targets: realpath the nearest
 * EXISTING ancestor, reattach the remainder. A NEW file created THROUGH a
 * junction then classifies by where it physically lands (round-2 fix).
 */
export async function physicalAncestorKey(p) {
  const { realpath } = await import("node:fs/promises");
  const { dirname: dn, join: pj } = await import("node:path");
  const base = stripExtendedLengthPrefix(p);
  let dir = dn(base);
  let prefix;
  for (;;) {
    try {
      prefix = await realpath(dir);
      break;
    } catch {
      const parent = dn(dir);
      if (parent === dir) return norm(base); // hit filesystem root without luck
      dir = parent;
    }
  }
  const rest = base.slice(dir.length).replaceAll("\\", "/");
  return norm(pj(prefix, rest));
}

/** git-common-dir of a checkout (main: <root>/.git ; worktree: file -> path). */
export function gitCommonDir(checkoutRoot) {
  const dotGit = join(checkoutRoot, ".git");
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) return norm(dotGit);
    const text = readFileSync(dotGit, "utf8").trim();
    const m = /gitdir:\s*(.+)/.exec(text);
    if (!m) return norm(dotGit);
    let gd = m[1].replaceAll("\\", "/");
    if (!isAbsolute(gd)) gd = resolve(checkoutRoot, gd);
    return norm(gd);
  } catch {
    return norm(dotGit); // not a checkout — caller treats as error
  }
}

/** Repo root of a checkout via git rev-parse --show-toplevel. */
export function gitTopLevel(cwd) {
  const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return norm(out);
}

/** Does `target` (normed) live inside `dir` (normed)? dir must be a directory root. */
export function isUnder(target, dir) {
  if (!target || !dir) return false;
  const t = target.endsWith("/") ? target.slice(0, -1) : target;
  const d = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return t === d || t.startsWith(d + "/");
}

/** Segment-match the VCS metadata dir itself (not .github etc.). */
export function isDotGitPath(normedTarget, commonDir) {
  // a) any path containing "/.git/" segment or ending "/.git"
  if (/(^|\/)\.git(\/|$)/.test(normedTarget)) return true;
  // b) the shared common dir (worktrees keep their state there)
  if (commonDir && isUnder(normedTarget, norm(commonDir))) return true;
  return false;
}

/** Split an absolute path against known roots -> classification.
 *  Worktrees are checked BEFORE main: the default layout nests copies under
 *  <mainRoot>/.worktrees/, so main-first would misclassify every copy as main. */
export function classifyTarget({ target, mainRoot, worktrees, commonDir }) {
  const t = norm(target);
  if (isDotGitPath(t, commonDir)) return { kind: "git-meta" };
  for (const w of worktrees) {
    if (isUnder(t, norm(w.root))) return { kind: "worktree", root: norm(w.root), name: w.name };
  }
  if (isUnder(t, norm(mainRoot))) return { kind: "main" };
  return { kind: "outside" };
}

/**
 * Extract absolute-path literals from a shell command string.
 * Lexical heuristic (P6): catches plain F:\... or /... tokens; deliberately
 * not exhaustive (8.3 / env concat documented as boundary).
 */
export function extractAbsolutePaths(command) {
  if (typeof command !== "string") return [];
  const out = new Set();
  const reWin = /(?:[a-zA-Z]:|\\\\\?\\|\\\\)[\\\/][^\s"'`;&|()<>]+/g;
  const reNix = /(?<![\w.~])\/(?:[\w.@+-]+\/)*[\w.@+-]+/g;
  for (const m of command.matchAll(reWin)) out.add(m[0]);
  for (const m of command.matchAll(reNix)) out.add(m[0]);
  return [...out];
}

export { IS_WIN, dirname };
