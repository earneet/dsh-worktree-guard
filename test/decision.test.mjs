// Unit tests for the frozen decision tables (design §6) — zcode A–R methodology.
import { test } from "node:test";
import assert from "node:assert/strict";
import { norm, stripExtendedLengthPrefix, classifyTarget, isDotGitPath, extractAbsolutePaths } from "../src/core/paths.mjs";
import { decideWrite, decideRead, decidePwsh, makeContext } from "../src/core/decision.mjs";
import { validateAllowlistPath, authorizeValid } from "../src/core/store.mjs";
import { resolveBinding } from "../src/core/binding.mjs";

// fixture world: main + two copies under main/.worktrees (default layout)
const MAIN = "F:/repo";
const WT_A = "F:/repo/.worktrees/worktree-alpha";
const WT_B = "F:/repo/.worktrees/worktree-beta";
const COMMON = "F:/repo/.git";
const ctx = makeContext({
  mainRoot: MAIN,
  commonDir: COMMON,
  worktrees: [{ root: WT_A, name: "worktree-alpha" }, { root: WT_B, name: "worktree-beta" }],
});
const bound = { worktree: WT_A, branch: "worktree-alpha" };

// ---------- paths ----------

test("norm: separator/case/\\\\?\\ normalization (win32 expectations on win32 host)", () => {
  assert.equal(norm("F:\\Repo\\SRC", "F:/x"), norm("f:/repo/src"));
  assert.equal(stripExtendedLengthPrefix("\\\\?\\C:\\a\\b"), "C:\\a\\b");
  assert.equal(stripExtendedLengthPrefix("\\\\?\\UNC\\server\\share"), "\\\\server\\share");
});

test("classify: worktree checked before main (copies nest under main/.worktrees)", () => {
  assert.equal(classifyTarget({ target: WT_A + "/src/a.ts", mainRoot: MAIN, worktrees: ctx.worktrees, commonDir: COMMON }).kind, "worktree");
  assert.equal(classifyTarget({ target: MAIN + "/src/a.ts", mainRoot: MAIN, worktrees: ctx.worktrees, commonDir: COMMON }).kind, "main");
  assert.equal(classifyTarget({ target: "F:/elsewhere/x", mainRoot: MAIN, worktrees: ctx.worktrees, commonDir: COMMON }).kind, "outside");
});

test("dotGit: segment match only, .github safe; common-dir containment counted", () => {
  assert.ok(isDotGitPath(norm(MAIN + "/.git"), COMMON));
  assert.ok(isDotGitPath(norm(MAIN + "/.git/config"), COMMON));
  assert.ok(!isDotGitPath(norm(MAIN + "/.github/workflows/x.yml"), COMMON));
  assert.ok(isDotGitPath(norm(COMMON + "/worktree-guard/state.json"), COMMON));
});

test("extractAbsolutePaths: catches plain absolute literals", () => {
  const got = extractAbsolutePaths(`git -C F:\\repo\\ run x && echo F:/repo/y`);
  assert.ok(got.some((p) => norm(p).startsWith(norm(MAIN))));
});

// ---------- decideWrite (A01–A09 lineage) ----------

test("W01 bound: relative path in own copy -> allow", () => {
  assert.equal(decideWrite("src/a.ts", WT_A, ctx, bound).kind, "allow");
});
test("W02 bound: absolute own copy -> allow", () => {
  assert.equal(decideWrite(WT_A + "/src/a.ts", MAIN, ctx, bound).kind, "allow");
});
test("W03 bound: main-root path -> deny with next-step", () => {
  const d = decideWrite(MAIN + "/src/a.ts", MAIN, ctx, bound);
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /主 checkout/);
  assert.match(d.reason, /下一步/); // three-part contract
});
test("W04 bound: other copy -> deny", () => {
  assert.match(decideWrite(WT_B + "/x", MAIN, ctx, bound).reason, /其他副本/);
});
test("W05 .git -> deny even unbound (always-on net)", () => {
  assert.match(decideWrite(MAIN + "/.git/config", MAIN, ctx, null).reason, /\.git/);
});
test("W06 state area -> deny (self-grant protection)", () => {
  assert.match(decideWrite(COMMON + "/worktree-guard/state.json", MAIN, ctx, null).reason, /状态区/);
});
test("W07 unbound: main write -> allow (P1 host semantics)", () => {
  assert.equal(decideWrite(MAIN + "/x", MAIN, ctx, null).kind, "allow");
});
test("W08 unbound: other copy write -> deny (cross-copy is ALWAYS-ON net)", () => {
  assert.match(decideWrite(WT_B + "/x", MAIN, ctx, null).reason, /副本/);
});
test("W09 relative path resolves against session cwd (rooted session)", () => {
  assert.equal(decideWrite("../src/a.ts", WT_A + "/sub", ctx, bound).kind, "allow"); // stays in own copy
  assert.match(decideWrite("../../src/a.ts", WT_A + "/sub", ctx, bound).reason, /主 checkout/);
});

// ---------- decideRead (§6.1) ----------

test("R01 bound: own copy -> allow, no mark", () => {
  const d = decideRead(WT_A + "/a.ts", WT_A, ctx, bound);
  assert.equal(d.kind, "allow");
  assert.equal(d.mark, undefined);
});
test("R02 bound: main read in warn -> allow + origin mark (P3)", () => {
  const d = decideRead(MAIN + "/a.ts", WT_A, ctx, bound);
  assert.equal(d.kind, "allow");
  assert.match(d.mark, /主 checkout/);
});
test("R03 bound: main read in strict -> deny with relative-path next-step", () => {
  const d = decideRead(MAIN + "/a.ts", WT_A, ctx, bound, { readPolicy: "strict" });
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /本副本/);
});
test("R04 other copy / .git reads stay open for troubleshooting", () => {
  assert.equal(decideRead(WT_B + "/a.ts", WT_A, ctx, bound).kind, "allow");
  assert.equal(decideRead(COMMON + "/HEAD", WT_A, ctx, bound).kind, "allow");
});
test("R05 unbound: main read -> plain allow, no mark (P1 no-noise)", () => {
  const d = decideRead(MAIN + "/a.ts", MAIN, ctx, null);
  assert.equal(d.kind, "allow");
  assert.equal(d.mark, undefined);
});

// ---------- decidePwsh (always-on net) ----------

test("S01 push to protected -> deny (any state)", () => {
  assert.match(decidePwsh({ command: "git push origin main" }, ctx, null).reason, /受保护分支/);
  assert.match(decidePwsh({ command: "git push origin master" }, ctx, bound).reason, /受保护分支/);
});
test("S02 push other branch -> allow", () => {
  assert.equal(decidePwsh({ command: "git push origin worktree-alpha" }, ctx, bound).kind, "allow");
});
test("S03 bare push while ON protected -> deny", () => {
  assert.match(decidePwsh({ command: "git push" , currentBranchName: "main" }, ctx, bound).reason, /受保护分支/);
  assert.equal(decidePwsh({ command: "git push", currentBranchName: "worktree-alpha" }, ctx, bound).kind, "allow");
});
test("S04 delete worktree branch -> deny", () => {
  assert.match(decidePwsh({ command: "git branch -D worktree-beta" }, ctx, null).reason, /worktree 分支/);
  assert.match(decidePwsh({ command: "git branch -d worktree-alpha" }, ctx, bound).reason, /worktree 分支/);
});
test("S05 delete normal branch -> allow", () => {
  assert.equal(decidePwsh({ command: "git branch -d feature-x" }, ctx, bound).kind, "allow");
});
test("S06 git -C <main> -> deny", () => {
  assert.match(decidePwsh({ command: `git -C ${MAIN} status` }, ctx, bound).reason, /定向/);
});
test("S07 bound: absolute main path in command -> deny with rewrite-free next-step", () => {
  assert.match(decidePwsh({ command: `echo ${MAIN}/a.txt` }, ctx, bound).reason, /主 checkout 绝对路径/);
});
test("S08 unbound: absolute main path -> allow (no binding, P1)", () => {
  assert.equal(decidePwsh({ command: `echo ${MAIN}/a.txt` }, ctx, null).kind, "allow");
});
test("S09 deny messages never leak detection rules", () => {
  for (const cmd of ["git push origin main", `git -C ${MAIN} status`, `echo ${MAIN}/x`]) {
    const r = decidePwsh({ command: cmd }, ctx, bound).reason;
    assert.ok(!/regex|正则|match/i.test(r), `leak in: ${r}`);
  }
});

// ---------- allowlist / authorize validation ----------

test("AL01 dangerous patterns rejected", () => {
  for (const p of ["/", ".git", ".git/x", "*", "../x"]) assert.ok(validateAllowlistPath(p));
});
test("AL02 normal paths accepted", () => {
  assert.equal(validateAllowlistPath("src/a.ts"), null);
});
test("AZ01 missing/expired TTL => invalid (fail-tight)", () => {
  assert.equal(authorizeValid({ allow_main_writes: { allow_main_writes: true } }), null);
  assert.equal(authorizeValid({ allow_main_writes: { allow_main_writes: true, allow_expires_at: "2000-01-01T00:00:00Z" } }), null);
  assert.ok(authorizeValid({ allow_main_writes: { allow_main_writes: true, allow_expires_at: new Date(Date.now() + 60000).toISOString() } }));
});

// ---------- binding resolution (three tiers) ----------

test("B01 tier1 own binding wins; tier3 null => open", async () => {
  const dir = await mkTempState();
  const { writeBinding } = await import("../src/core/store.mjs");
  await writeBinding(dir, "s1", { worktree: WT_A, branch: "b" });
  assert.equal((await resolveBinding(dir, { sessionId: "s1" })).source, "self");
  assert.equal(await resolveBinding(dir, { sessionId: "s9" }), null);
  await rmTempState(dir);
});
test("B02 tier2 parent chain snapshot, depth-capped", async () => {
  const dir = await mkTempState();
  const { writeBinding, readBinding } = await import("../src/core/store.mjs");
  await writeBinding(dir, "root", { worktree: WT_A, branch: "b" });
  const snap = await resolveBinding(dir, { sessionId: "child", parentSession: "root" });
  assert.equal(snap.source, "inherited");
  assert.ok(await readBinding(dir, "child")); // snapshotted
  // deep chain beyond cap resolves to null (open)
  let prev = "root";
  const parents = { c1: "root", c2: "c1" };
  for (let i = 0; i < 15; i++) { const nx = `c${i + 3}`; parents[nx] = prev; prev = nx; }
  const deep = await resolveBinding(dir, { sessionId: "deep", parentSession: prev }, { listParents: (s) => parents[s] ?? null });
  // chain is empty (no bindings along it) -> null
  assert.equal(deep, null);
  await rmTempState(dir);
});

// ---------- temp state helpers ----------

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function mkTempState() {
  const d = await mkdtemp(join(tmpdir(), "wtg-test-"));
  await mkdir(join(d, "bindings"), { recursive: true });
  return d;
}
async function rmTempState(d) {
  await rm(d, { recursive: true, force: true });
}
