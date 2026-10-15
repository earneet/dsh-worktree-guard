// Round-2 adversarial review regressions.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePwsh, decideWrite, makeContext } from "../src/core/decision.mjs";
import { decideToolCall } from "../src/guard.mjs";
import { addAllowEntry, readAllowlist } from "../src/core/store.mjs";
import { commonDir } from "../src/core/gitops.mjs";
import { norm } from "../src/core/paths.mjs";
import { MAIN, WT_A, WT_B, COMMON } from "./helpers/fixtures.mjs";

const ctx = makeContext({ mainRoot: MAIN, commonDir: COMMON, worktrees: [{ root: WT_A, name: "worktree-alpha" }, { root: WT_B, name: "worktree-beta" }] });
const bound = { worktree: WT_A, branch: "worktree-alpha" };

// ---- R2 #1 blocker: CLI authorize channel unreachable from shell ----

test("R2-1 blocker: wt.mjs authorize-main via shell denied in any form", () => {
  for (const cmd of [
    'node wt.mjs authorize-main "x" --ttl-minutes 240',
    "node F:/tools/wt.mjs authorize_main --ttl-minutes 240",
    'authorize-main "because" | node wt.mjs',
  ]) {
    const d = decidePwsh({ command: cmd }, ctx, bound);
    assert.equal(d.kind, "deny", `must deny: ${cmd}`);
  }
});

// ---- R2 #3 major: decoy multi-branch delete + equals form ----

test("R2-3 major: decoy-first and equals-form branch deletes denied", () => {
  for (const cmd of [
    "git branch -d feature-x worktree-beta",
    "git branch -D -f feature-x worktree-beta",
    "git branch --delete worktree-alpha extra",
    "git branch -d worktree-alpha",
  ]) {
    assert.equal(decidePwsh({ command: cmd }, ctx, bound).kind, "deny", `must deny: ${cmd}`);
  }
  assert.equal(decidePwsh({ command: "git branch -d feature-x" }, ctx, bound).kind, "allow");
  assert.equal(decidePwsh({ command: "git branch -a" }, ctx, bound).kind, "allow"); // listing has no token
});

// ---- R2 #4 medium: -C variants ----

test("R2-4 medium: -C sub/../../.. and -C . checkout main denied while bound", () => {
  assert.equal(decidePwsh({ command: "git -C node_modules/../../.. status" }, ctx, bound).kind, "deny");
  assert.equal(decidePwsh({ command: "git -C . checkout main" }, ctx, bound).kind, "deny");
  assert.equal(decidePwsh({ command: "git -C . checkout feature-x" }, ctx, bound).kind, "allow");
});

// ---- R2 #6 medium: remote branch deletion ----

test("R2-6 medium: push --delete / refspec-colon worktree branch denied", () => {
  assert.equal(decidePwsh({ command: "git push origin --delete worktree-beta" }, ctx, bound).kind, "deny");
  assert.equal(decidePwsh({ command: "git push origin :worktree-beta" }, ctx, bound).kind, "deny");
  assert.equal(decidePwsh({ command: "git push origin worktree-alpha" }, ctx, bound).kind, "allow");
});

// ---- R2 #8 low: malformed protectedBranches never crashes the net ----

test("R2-8 low: non-string protectedBranches falls back safely (no throw, still denies)", () => {
  const badCtx = makeContext({ mainRoot: MAIN, commonDir: COMMON, worktrees: [] });
  badCtx.protectedBranches = ["main", 42, null];
  const d = decidePwsh({ command: "git push origin main" }, badCtx, bound);
  assert.equal(d.kind, "deny");
});

// ---- R2 #2 major: allowlist keys repo-absolute ----

let repo, wt, cd;
function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function mkExec({ tool, args, cwd, sessionId = "s1" }) {
  return { name: tool, arguments: args, callId: `c${Math.random()}`, agent: { session: { header: { id: sessionId, cwd } } } };
}

test("R2-2 major: allowlist relative path keys against mainRoot, `.` rejected", async () => {
  const d = await mkdtemp(join(tmpdir(), "wtg-r2-"));
  repo = d;
  sh(d, "git", ["init", "-b", "main"]);
  sh(d, "git", ["config", "user.email", "t@t"]); sh(d, "git", ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "x"); sh(d, "git", ["add", "."]); sh(d, "git", ["commit", "-m", "i", "-q"]);
  const lc = await import("../src/core/lifecycle.mjs");
  wt = (await lc.create({ taskName: "alpha", cwd: d })).worktree;
  cd = await commonDir(wt);
  await lc.enter({ path: wt, sessionId: "s1", cwd: wt });

  const e = await addAllowEntry(cd, { path: "docs", reason: "t", ttlMinutes: 5, grantedBy: "t", mainRoot: norm(d) });
  assert.equal(e.path, norm(join(d, "docs")), "key must be repo-absolute, not process-cwd");
  const entries = (await readAllowlist(cd)).entries;
  assert.ok(Object.keys(entries).includes(norm(join(d, "docs"))));
  // grant actually lifts the write deny for its subtree
  await mkdir(join(d, "docs"), { recursive: true });
  const w = await decideToolCall(mkExec({ tool: "write", args: { file_path: join(d, "docs", "x.md") }, cwd: wt }), {});
  assert.equal(w.kind, "allow", "granted subtree write must pass");
  // `.` is rejected
  await assert.rejects(() => addAllowEntry(cd, { path: ".", reason: "t", ttlMinutes: 5, grantedBy: "t", mainRoot: norm(d) }));
});

// ---- R2 #7 low: concurrent allowlist adds all land ----

test("R2-7 low: three concurrent grants all persist", async () => {
  const rs = await Promise.allSettled([
    addAllowEntry(cd, { path: "p1", reason: "t", ttlMinutes: 5, grantedBy: "t", mainRoot: norm(repo) }),
    addAllowEntry(cd, { path: "p2", reason: "t", ttlMinutes: 5, grantedBy: "t", mainRoot: norm(repo) }),
    addAllowEntry(cd, { path: "p3", reason: "t", ttlMinutes: 5, grantedBy: "t", mainRoot: norm(repo) }),
  ]);
  for (const r of rs) assert.equal(r.status, "fulfilled");
  const keys = Object.keys((await readAllowlist(cd)).entries);
  for (const p of ["p1", "p2", "p3"]) assert.ok(keys.some((k) => k.endsWith(p)), `missing ${p}`);
});

// ---- R2 #5 medium: NEW file through junction classifies physically ----

test("R2-5 medium: new file written through a junction into main is denied", async () => {
  // isolate from R2-2's docs grant
  const { clearAllowlist } = await import("../src/core/store.mjs");
  await clearAllowlist(cd);
  // junction inside the copy pointing at <main>/docs
  await symlink(join(repo, "docs"), join(wt, "linkdocs"), "junction");
  const w = await decideToolCall(mkExec({ tool: "write", args: { file_path: join(wt, "linkdocs", "new.md") }, cwd: wt }), {});
  assert.equal(w.kind, "deny", "new file through junction into main must be denied");
  // existing-file case (round-1) still denied
  const w2 = await decideToolCall(mkExec({ tool: "edit", args: { file_path: join(wt, "linkdocs", "x.md") }, cwd: wt }), {});
  assert.equal(w2.kind, "deny");
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true }).catch(() => {});
});
