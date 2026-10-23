// core/lifecycle.js — worktree lifecycle shared by native tools (wt-tools.js)
// and the human CLI (wt.js). Pure orchestration over gitops/store; no cordis.
import { join, resolve, dirname } from "node:path";
import { mkdir, cp, access, writeFile, readdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import {
  addWorktree, removeWorktree, listWorktrees, commonDir, currentBranch,
  isAncestor, deleteMergedBranch, branchExists, isDirtyForLifecycle, scanAndRemoveAllLinks,
  worktreeNameOf, git,
} from "./gitops.js";
import { norm } from "./paths.js";
import { writeBinding, deleteBinding, readState, updateState, appendAudit, listBindings } from "./store.js";
import { loadSidecar } from "./sidecar.js";
import { DEFAULT_BRANCH_PREFIX, DEFAULT_WORKTREE_PARENT, STALE_THRESHOLD_MS } from "./constants.js";

async function exists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Sidecar merged over defaults (snake/camel normalized; MAIN-ROOT based — the
 *  session cwd may be a copy whose .dsh has no sidecar). */
async function repoCfg(mainRoot) {
  return loadSidecar(mainRoot);
}

/**
 * create: worktree under <mainRoot>/<worktreeParent>/worktree-<slug> + branch.
 * sync: copyFiles copied; symlinkDirs junctioned (win32) / symlinked.
 * Also writes plugin-owned DSH-space files (P7): task-brief + cleanup skill.
 */
export async function create(opts) {
  const { taskName, taskBrief, cwd } = opts;
  const { mainRoot } = await listWorktrees(cwd);
  if (!mainRoot) throw new Error("不在 git 仓库中，无法创建 worktree");
  const config = { ...(await repoCfg(mainRoot)), ...(opts.config ?? {}) };
  const slug = slugify(taskName);
  const prefix = config.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  const branch = `${prefix}${slug}`;
  const parentDir = resolve(mainRoot, config.worktreeParent ?? DEFAULT_WORKTREE_PARENT);
  const wtPath = join(parentDir, `${prefix}${slug}`);
  if (await exists(wtPath)) throw new Error(`目录已存在：${wtPath}`);
  if (await branchExists(mainRoot, branch)) throw new Error(`分支已存在：${branch}`);

  const base = config.baseRef ?? (await currentBranch(mainRoot)) ?? "HEAD";
  await mkdir(parentDir, { recursive: true });
  await addWorktree(mainRoot, wtPath, branch, base);

  const sync = config.sync ?? {};
  for (const rel of sync.copyFiles ?? []) {
    const src = join(mainRoot, rel);
    const dst = join(wtPath, rel);
    if (await exists(src)) {
      await mkdir(dirname(dst), { recursive: true });
      await cp(src, dst, { recursive: true });
    }
  }
  for (const rel of sync.symlinkDirs ?? []) {
    const src = join(mainRoot, rel);
    const dst = join(wtPath, rel);
    if (await exists(src)) {
      await mkdir(dirname(dst), { recursive: true });
      const { symlink } = await import("node:fs/promises");
      try {
        await symlink(src, dst, "junction");
      } catch {
        await symlink(src, dst, "dir");
      }
    }
  }

  // P7: plugin-owned files inside DSH config space only.
  const briefDir = join(wtPath, ".dsh");
  await mkdir(briefDir, { recursive: true });
  if (taskBrief) await writeFile(join(briefDir, "task-brief.md"), taskBrief, "utf8");
  await mkdir(join(briefDir, "skills", "worktree-cleanup"), { recursive: true });
  await writeFile(join(briefDir, "skills", "worktree-cleanup", "SKILL.md"), CLEANUP_SKILL.replaceAll("{{BRANCH}}", branch).replaceAll("{{WT}}", wtPath), "utf8");

  const cd = await commonDir(cwd);
  await updateState(cd, { last_active: norm(wtPath) });
  await appendAudit(cd, { type: "create", worktree: wtPath, branch, base });
  return { worktree: wtPath, branch, base, mainRoot };
}

/** enter: bind THIS session (rooted check happens at the tool layer for models). */
export async function enter({ path, sessionId, cwd }) {
  const target = resolve(cwd, path ?? ".");
  const { mainRoot: mainFromCwd } = await listWorktrees(cwd);
  const { entries } = await listWorktrees(target);
  const found = entries.find((e) => norm(e.root) === norm(target));
  if (!found) throw new Error(`不是已注册的 worktree：${target}`);
  if (norm(target) === norm(mainFromCwd)) throw new Error("目标是主 checkout：绑定对象必须是副本（以副本为根开会话即可，无需 enter）");
  const cd = await commonDir(target);
  const binding = { worktree: norm(target), branch: found.branch ?? null, base: null, entered_at: new Date().toISOString() };
  await writeBinding(cd, sessionId, { ...binding, source: "self" });
  await updateState(cd, { last_active: binding.worktree });
  await appendAudit(cd, { type: "enter", session: sessionId, worktree: binding.worktree });
  return binding;
}

/** exit: unbind; action=remove triggers removal (merged-only by default). */
export async function exitSession({ sessionId, cwd, action = "keep", config = {} }) {
  const cd = await commonDir(cwd);
  const mine = (await listBindings(cd)).find((b) => b.sessionId === sessionId);
  if (!mine) return { exited: false, message: "本会话没有绑定" };
  await deleteBinding(cd, sessionId); // P5: own binding never blocks own exit
  await appendAudit(cd, { type: "exit", session: sessionId, worktree: mine.worktree, action });
  if (action === "remove") {
    return remove({ path: mine.worktree, cwd, confirmRemove: true, deleteBranch: true, config, sessionId });
  }
  return { exited: true, worktree: mine.worktree };
}

/**
 * remove: exit-first flow — the session must unbind before the copy is
 * deleted (§8). Link scan strips ALL links before `git worktree remove`
 * (traversal protection); branch deletion merged-only.
 */
export async function remove({ path, cwd, confirmRemove = false, deleteBranch = false, config = {}, sessionId = "cli" }) {
  if (!confirmRemove) return { removed: false, needConfirm: true, path };
  const target = resolve(cwd, path);
  const cd = await commonDir(cwd);
  const { entries, mainRoot } = await listWorktrees(cwd);
  const found = entries.find((e) => norm(e.root) === norm(target));
  if (!found) return { removed: false, message: `不是已注册的 worktree：${target}` };

  const branch = found.branch;
  if ((await isDirtyForLifecycle(target)) && !config.force) {
    return { removed: false, message: "副本有未提交变更：请先提交或 stash（或配置 force）" };
  }
  const base = config.baseRef ?? "HEAD";
  if (deleteBranch && branch) {
    const merged = await isAncestor(mainRoot, branch, base);
    if (!merged && !config.force) {
      return { removed: false, message: `分支 ${branch} 未合并进 ${base}：仅删除已合并分支（合并后重试，或配置 force）` };
    }
  }
  // P5: bindings pointing at this worktree never block removal; recycle them.
  for (const b of await listBindings(cd)) {
    if (norm(b.worktree) === norm(target)) await deleteBinding(cd, b.sessionId);
  }
  await scanAndRemoveAllLinks(target, { skip: [join(target, ".git")] });
  // Round-7: the isDirtyForLifecycle gate above is the authoritative check —
  // if it passed, the only possible untracked files are plugin-owned .dsh/
  // ones, which git's own untracked check would still refuse. Force the
  // git-level removal; genuinely dirty copies were already refused.
  await removeWorktree(mainRoot, target, { force: true });
  if (deleteBranch && branch && (await branchExists(mainRoot, branch))) {
    try {
      await deleteMergedBranch(mainRoot, branch);
    } catch {
      if (!config.force) return { removed: true, branchKept: true, message: `副本已删；分支 ${branch} 未合并保留` };
      await git(mainRoot, ["branch", "-D", branch]);
    }
  }
  await appendAudit(cd, { type: "remove", worktree: norm(target), branch, by: sessionId });
  return { removed: true, branch };
}

/** status: proof-based inventory (merge-base), binding overview, stale marks, orphans. */
export async function status({ cwd, sessionId = null }) {
  const cd = await commonDir(cwd);
  const { mainRoot, entries } = await listWorktrees(cwd);
  const bindings = await listBindings(cd);
  const now = Date.now();
  const copies = [];
  for (const e of entries) {
    if (norm(e.root) === norm(mainRoot) || e.bare) continue;
    const merged = e.branch ? await isAncestor(mainRoot, e.branch, "HEAD") : false;
    const dirty = await isDirtyForLifecycle(e.root);
    const boundBy = bindings.filter((b) => norm(b.worktree) === norm(e.root));
    const staleSessions = boundBy.filter((b) => now - Date.parse(b.resolved_at ?? b.entered_at ?? 0) > STALE_THRESHOLD_MS);
    copies.push({
      name: worktreeNameOf(e.root), root: e.root, branch: e.branch,
      merged_into_head: merged, dirty, bound_sessions: boundBy.length,
      stale: staleSessions.length > 0,
    });
  }
  const mine = sessionId ? bindings.find((b) => b.sessionId === sessionId) ?? null : null;
  const rooted = mine ? norm(cwd) === norm(mine.worktree) : false;
  return {
    mode: mine ? (rooted ? "rooted" : "repo-rooted") : "unbound",
    binding: mine, copies,
    stale_state_hint: mine ? null : (await readState(cd)).last_active,
    orphan_dirs: await orphanDirs(mainRoot, entries),
  };
}

/** Dirs under the worktree parent that are NOT registered worktrees. */
async function orphanDirs(mainRoot, entries) {
  if (!mainRoot) return [];
  const cfg = await repoCfg(mainRoot);
  const parent = join(mainRoot, cfg.worktreeParent ?? DEFAULT_WORKTREE_PARENT);
  const registered = new Set(entries.map((e) => norm(e.root)));
  let dirents;
  try {
    dirents = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const p = norm(join(parent, d.name));
    let isSymlink = false;
    try {
      isSymlink = (await stat(join(parent, d.name))).isSymbolicLink();
    } catch { /* ignore */ }
    if (!registered.has(p) && !isSymlink) out.push(p);
  }
  return out;
}

/** prune: drop bindings whose worktree AND branch are both gone, or session silent past threshold. */
export async function prune({ cwd, dryRun = false }) {
  const cd = await commonDir(cwd);
  const bindings = await listBindings(cd);
  const { entries } = await listWorktrees(cwd);
  const roots = new Set(entries.map((e) => norm(e.root)));
  const now = Date.now();
  const dropped = [];
  for (const b of bindings) {
    const gone = !roots.has(norm(b.worktree));
    const silent = now - Date.parse(b.resolved_at ?? b.entered_at ?? 0) > STALE_THRESHOLD_MS;
    if (gone || silent) {
      dropped.push({ sessionId: b.sessionId, worktree: b.worktree, reason: gone ? "worktree 已不存在" : "会话静默超阈" });
      if (!dryRun) await deleteBinding(cd, b.sessionId);
    }
  }
  if (!dryRun && dropped.length) await appendAudit(cd, { type: "prune", dropped });
  return { dropped, dryRun };
}

export function slugify(name) {
  return String(name ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

export { STALE_THRESHOLD_MS };

const CLEANUP_SKILL = `# worktree-cleanup

本目录是 worktree 副本（分支 {{BRANCH}}）。收尾流程：

1. 完成并提交本副本的工作。
2. 调用 worktree_status：确认 merged_into_head=true（已合并证明）。
3. 用户确认后：经用户同意调用 worktree_authorize_main 授权合并回主干。不要手动执行 git branch -d——分支删除由第 4 步的工具自动完成（仅删已合并分支）。
4. worktree_exit {action:"remove"} 清理副本并删除已合并分支。
`;
