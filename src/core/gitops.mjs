// core/gitops.mjs — git operations over async child_process (round-5 M1: the
// guard runs on hot async paths; execFileSync blocked the host event loop
// 30-100ms per spawn on Windows). No cordis deps; every function takes an
// explicit cwd and returns plain data; rejects on git failure.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, resolve } from "node:path";
import { norm, isUnder } from "./paths.mjs";

const execFileP = promisify(execFile);

async function git(cwd, args, opts = {}) {
  const { stdout } = await execFileP("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
  return stdout;
}

export async function gitOk(cwd, args) {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** Registered worktrees; the main checkout is always listed first (skip bare). */
export async function listWorktrees(cwd) {
  const out = await git(cwd, ["worktree", "list", "--porcelain"]);
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
  const firstNonBare = entries.find((e) => !e.bare);
  const mainRoot = firstNonBare ? firstNonBare.root : null;
  return { mainRoot, entries };
}

/** git-common-dir (shared state) for a checkout. NOTE: git prints a RELATIVE
 *  path (".git") at top level — resolve against the target cwd, never process.cwd(). */
export async function commonDir(cwd) {
  const out = (await git(cwd, ["rev-parse", "--git-common-dir"])).trim();
  return norm(isAbsolute(out) ? out : resolve(cwd, out));
}

/** Current branch short name, or null (detached / failure). */
export async function currentBranch(cwd) {
  try {
    return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
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
export async function deleteMergedBranch(cwd, branch) {
  await git(cwd, ["branch", "-d", branch]);
}

export async function addWorktree(cwd, path, branch, baseRef) {
  const args = ["worktree", "add"];
  if (baseRef) args.push("-b", branch, path, baseRef);
  else args.push("-b", branch, path);
  await git(cwd, args);
}

export async function removeWorktree(cwd, path, { force = false } = {}) {
  await git(cwd, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
}

/** Uncommitted-changes check for a checkout. */
export async function isDirty(cwd) {
  const out = (await git(cwd, ["status", "--porcelain"])).trim();
  return out.length > 0;
}

/** Directory basename used as the copy's short name. */
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
