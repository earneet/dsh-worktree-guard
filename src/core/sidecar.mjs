// core/sidecar.mjs — <repo>/.dsh/worktree-guard.json loader (P7: DSH config
// space only). Accepts BOTH snake_case (the design doc's §13 spelling) and
// camelCase keys.
// Always resolved against the repo MAIN ROOT (not the session cwd): rooted
// sessions live inside a copy whose .dsh has no sidecar. No TTL cache — a
// small fs read is far cheaper than the git spawns around it, and staleness
// here silently disables user configuration (round-5 B1).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { norm } from "./paths.mjs";

export async function loadSidecar(repoRoot) {
  const key = norm(repoRoot ?? process.cwd());
  let cfg = {};
  try {
    const text = await readFile(join(key, ".dsh", "worktree-guard.json"), "utf8");
    cfg = normalizeSidecar(JSON.parse(text));
  } catch {
    cfg = {};
  }
  return cfg;
}

/** Normalize one sidecar document: snake_case keys -> canonical camelCase. */
export function normalizeSidecar(raw = {}) {
  const out = { ...raw };
  const map = {
    branch_prefix: "branchPrefix",
    worktree_parent: "worktreeParent",
    protected_branches: "protectedBranches",
    read_policy: "readPolicy",
    main_write_whitelist: "mainWriteWhitelist",
    authorize_ttl_minutes: "authorizeTtlMinutes",
    allowlist_ttl_minutes: "allowlistTtlMinutes",
  };
  for (const [snake, camel] of Object.entries(map)) {
    if (out[snake] !== undefined && out[camel] === undefined) out[camel] = out[snake];
    delete out[snake];
  }
  if (out.sync && typeof out.sync === "object") {
    const s = out.sync;
    if (s.copy_files !== undefined && s.copyFiles === undefined) s.copyFiles = s.copy_files;
    if (s.symlink_dirs !== undefined && s.symlinkDirs === undefined) s.symlinkDirs = s.symlink_dirs;
    delete s.copy_files;
    delete s.symlink_dirs;
  }
  return out;
}

/** Glob-style whitelist match supporting `*`, `?`, `**` (pathsegment-agnostic, case-folded). */
export function globMatch(pattern, target) {
  const p = norm(pattern);
  const t = norm(target);
  const re = p
    .replaceAll(".", "\\.")
    .replaceAll("**/", "(?:.*/)?")
    .replaceAll("**", ".*")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]");
  return new RegExp(`^${re}$`).test(t);
}

/** Does `target` (absolute, normed) match any mainWriteWhitelist pattern? */
export function matchesMainWhitelist(target, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => typeof p === "string" && p.trim() !== "" && globMatch(p, target));
}
