// core/gitops.mjs — pure-ish git operations over child_process. No cordis deps.
// Every function takes an explicit cwd and returns plain data; throws on git failure.
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { norm, isUnder } from "./paths.mjs";

function git(cwd, args, opts = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", opts.ignoreStderr ? "ignore" : "pipe"],
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
}

export function gitOk(cwd, args) {
  try {
    git(cwd, args, { ignoreStderr: true });
    return true;
  } catch {
    return false;
  }
}

/** Main checkout root = the worktree whose .git is a directory, from `git worktree list`. */
export function listWorktrees(cwd) {
  const out = git(cwd, ["worktree", "list", "--porcelain"], { ignoreStderr: true });
  const entries = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { root: norm(line.slice(9).trim()), bare: false, detached: false, branch: null };
    } else if (cur && line.startsWith("bare")) cur.bare = true;
    else if (cur && line.startsWith("detached")) cur.detached = true;
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
  }
  if (cur) entries.push(cur);
  // `git worktree list` always lists the main checkout first; skip bare repos.
  const firstNonBare = entries.find((e) => !e.bare);
  const mainRoot = firstNonBare ? firstNonBare.root : null;
  return { mainRoot, entries };
}

/** git-common-dir (shared state) for a checkout. NOTE: git prints a RELATIVE
 *  path (".git") at top level — resolve against the target cwd, never process.cwd(). */
export function commonDir(cwd) {
  const out = git(cwd, ["rev-parse", "--git-common-dir"], { ignoreStderr: true }).trim();
  return norm(isAbsolute(out) ? out : resolve(cwd, out));
}

/** Current branch short name, or null (detached). */
export function currentBranch(cwd) {
  try {
    return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { ignoreStderr: true }).trim();
  } catch {
    return null;
  }
}

/** Ancestor proof: is `branch` merged into `base`? (chuck-ma lineage) */
export function isAncestor(cwd, branch, base) {
  return gitOk(cwd, ["merge-base", "--is-ancestor", branch, base]);
}

export function branchExists(cwd, branch) {
  return gitOk(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
}

/** Only deletes merged branches (built-in merge protection). */
export function deleteMergedBranch(cwd, branch) {
  git(cwd, ["branch", "-d", branch], { ignoreStderr: true });
}

export function addWorktree(cwd, path, branch, baseRef) {
  const args = ["worktree", "add"];
  if (baseRef) args.push("-b", branch, path, baseRef);
  else args.push("-b", branch, path);
  git(cwd, args);
}

export function removeWorktree(cwd, path, { force = false } = {}) {
  git(cwd, ["worktree", "remove", ...(force ? ["--force"] : []), path], { ignoreStderr: true });
}

/** Uncommitted-changes check for a checkout. */
export function isDirty(cwd) {
  const out = git(cwd, ["status", "--porcelain"], { ignoreStderr: true }).trim();
  return out.length > 0;
}

/** list branches already merged into base. */
export function mergedBranches(cwd, base) {
  const out = git(cwd, ["branch", "--merged", base], { ignoreStderr: true });
  return out
    .split("\n")
    .map((l) => l.replace(/^[*+]\s*/, "").trim())
    .filter((l) => l && !l.includes(" "));
}

/** Parse `git worktree list` names derived from directory basename. */
export function worktreeNameOf(root) {
  const parts = norm(root).split("/");
  return parts[parts.length - 1] || norm(root);
}

/** Strip ALL symlinks/junctions under root (link_scan:"all" default) before worktree removal. */
export async function scanAndRemoveAllLinks(root, { skip = [] } = {}) {
  const { lstat, readdir, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const skipNorm = new Set(skip.map(norm));
  let removed = 0;
  async function walk(dir) {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const p = join(dir, d.name);
      let st;
      try {
        st = await lstat(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        if (skipNorm.has(norm(p))) continue;
        try {
          await unlink(p);
          removed++;
        } catch {
          /* best effort */
        }
      } else if (st.isDirectory()) {
        await walk(p);
      }
    }
  }
  await walk(root);
  return removed;
}

export { git, isUnder };
