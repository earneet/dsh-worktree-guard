// Round-7 regressions: iterations from the 2026-10-14 full test report.
//  R7-1 finding #2: fresh create must NOT be dirty for lifecycle decisions
//        (untracked plugin-owned .dsh/ ignored) -> remove without --force works.
//  R7-2 no repository state is modified to achieve this (shared info/exclude
//        untouched, .dsh/ still visible to plain git status / isDirty).
//  R7-3 real user work still shows dirty (untracked user file, or tracked
//        .dsh edits) — the ignore list never masks actual changes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lifecycle from "../src/core/lifecycle.js";
import { isDirty, isDirtyForLifecycle } from "../src/core/gitops.js";

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function makeRepo() {
  const d = await mkdtemp(join(tmpdir(), "wtg-r7-"));
  sh(d, "git", ["init", "-b", "main"]);
  sh(d, "git", ["config", "user.email", "t@t"]);
  sh(d, "git", ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "hello\n", "utf8");
  await writeFile(join(d, ".gitignore"), ".worktrees/\n", "utf8");
  sh(d, "git", ["add", "."]);
  sh(d, "git", ["commit", "-m", "init", "-q"]);
  return d;
}

let repo;
before(async () => { repo = await makeRepo(); });
after(async () => { await rm(repo, { recursive: true, force: true }).catch(() => {}); });

test("R7-1 fresh create is clean for lifecycle -> remove without force succeeds", async () => {
  const r = await lifecycle.create({ taskName: "clean remove", taskBrief: "b", cwd: repo });
  assert.equal(await isDirtyForLifecycle(r.worktree), false, "plugin-owned .dsh/ must not count");
  const rm1 = await lifecycle.remove({ path: r.worktree, cwd: repo, confirmRemove: true, deleteBranch: false, config: {} });
  assert.equal(rm1.removed, true, "no --force needed on a freshly created copy");
});

test("R7-2 no repo-state side effects: exclude untouched, plain status still sees .dsh/", async () => {
  const r = await lifecycle.create({ taskName: "no sidefx", cwd: repo });
  // shared info/exclude must not gain entries
  const shared = await import("node:fs/promises").then((m) => m.readFile(join(repo, ".git", "info", "exclude"), "utf8")).catch(() => "");
  assert.ok(!shared.includes(".dsh/"), "shared info/exclude must stay untouched");
  // plain git semantics preserved: isDirty still true (untracked .dsh visible)
  assert.equal(await isDirty(r.worktree), true);
  assert.equal(await isDirty(repo), false, "main checkout unaffected");
  await lifecycle.remove({ path: r.worktree, cwd: repo, confirmRemove: true, config: {} });
});

test("R7-3 ignore list never masks real work: user file or tracked .dsh edits -> dirty", async () => {
  const r = await lifecycle.create({ taskName: "real dirty", taskBrief: "b", cwd: repo });
  await writeFile(join(r.worktree, "user-work.txt"), "x", "utf8");
  assert.equal(await isDirtyForLifecycle(r.worktree), true, "untracked user file counts");
  const out = await lifecycle.remove({ path: r.worktree, cwd: repo, confirmRemove: true, config: {} });
  assert.equal(out.removed, false);
  assert.match(out.message, /未提交变更/);
  await rm(join(r.worktree, "user-work.txt"), { force: true });
  // tracked .dsh content (user committed then edited) must still count
  sh(r.worktree, "git", ["add", ".dsh"]);
  sh(r.worktree, "git", ["commit", "-q", "-m", "dsh"]);
  await writeFile(join(r.worktree, ".dsh", "task-brief.md"), "edited\n", "utf8");
  assert.equal(await isDirtyForLifecycle(r.worktree), true, "tracked .dsh edits count");
  await lifecycle.remove({ path: r.worktree, cwd: repo, confirmRemove: true, config: { force: true } });
});
