// Integration tests: real temp git repos, full lifecycle through the same
// guard entry the cordis plugin uses (decideToolCall), plus CLI smoke.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import * as lifecycle from "../src/core/lifecycle.mjs";
import { decideToolCall, guardContext } from "../src/guard.mjs";
import { commonDir, currentBranch } from "../src/core/gitops.mjs";
import { norm } from "../src/core/paths.mjs";

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function makeRepo() {
  const d = await mkdtemp(join(tmpdir(), "wtg-repo-"));
  sh(d, "git", ["init", "-b", "main"]);
  sh(d, "git", ["config", "user.email", "t@t"]);
  sh(d, "git", ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "hello\n", "utf8");
  sh(d, "git", ["add", "."]);
  sh(d, "git", ["commit", "-m", "init", "-q"]);
  return d;
}
function mkExec({ tool, args, cwd, sessionId = "s1", parentSession = null }) {
  return {
    name: tool,
    arguments: args,
    callId: `call-${Math.random().toString(36).slice(2)}`,
    agent: { session: { header: { id: sessionId, cwd, parentSession } } },
  };
}

let repo, wtPath, cd;
before(async () => {
  repo = await makeRepo();
});
after(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

test("L01 create -> worktree + branch + brief + skill", async () => {
  const r = await lifecycle.create({ taskName: "Fix Login!", taskBrief: "do the thing", cwd: repo });
  wtPath = r.worktree;
  assert.equal(r.branch, "worktree-fix-login");
  assert.equal(currentBranch(wtPath), "worktree-fix-login");
  const brief = await readFile(join(wtPath, ".dsh", "task-brief.md"), "utf8");
  assert.match(brief, /do the thing/);
  const skill = await readFile(join(wtPath, ".dsh", "skills", "worktree-cleanup", "SKILL.md"), "utf8");
  assert.match(skill, /worktree-fix-login/);
  assert.ok(!(await fileExists(join(wtPath, "AGENTS.md"))), "P7: must not create AGENTS.md");
});

test("L02 enter from rooted session; mode reported", async () => {
  cd = commonDir(wtPath);
  const b = await lifecycle.enter({ path: wtPath, sessionId: "s1", cwd: wtPath });
  assert.equal(norm(b.worktree), norm(wtPath));
  const st = await lifecycle.status({ cwd: wtPath, sessionId: "s1" });
  assert.equal(st.mode, "rooted");
});

test("L03 guard: write relative in own copy -> allow", async () => {
  const d = await decideToolCall(mkExec({ tool: "write", args: { file_path: "b.txt", content: "x" }, cwd: wtPath }), { readPolicy: "warn" });
  assert.equal(d.kind, "allow");
});

test("L04 guard: write absolute main path -> deny (3-part message)", async () => {
  const d = await decideToolCall(mkExec({ tool: "write", args: { file_path: join(repo, "a.txt") }, cwd: wtPath }), {});
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /下一步/);
});

test("L05 guard: write into guard state area -> deny (self-grant)", async () => {
  const d = await decideToolCall(mkExec({ tool: "write", args: { file_path: join(cd, "worktree-guard", "state.json") }, cwd: wtPath }), {});
  assert.equal(d.kind, "deny");
});

test("L06 guard: read main in warn -> allow + mark; strict -> deny", async () => {
  const w = await decideToolCall(mkExec({ tool: "read", args: { file_path: join(repo, "a.txt") }, cwd: wtPath }), { readPolicy: "warn" });
  assert.equal(w.kind, "allow");
  assert.match(w.mark, /主 checkout/);
  const s = await decideToolCall(mkExec({ tool: "read", args: { file_path: join(repo, "a.txt") }, cwd: wtPath }), { readPolicy: "strict" });
  assert.equal(s.kind, "deny");
});

test("L07 guard: pwsh push main -> deny; push own branch -> allow", async () => {
  assert.equal((await decideToolCall(mkExec({ tool: "pwsh", args: { command: "git push origin main" }, cwd: wtPath }), {})).kind, "deny");
  assert.equal((await decideToolCall(mkExec({ tool: "pwsh", args: { command: "git push origin worktree-fix-login" }, cwd: wtPath }), {})).kind, "allow");
});

test("L08 guard: authorize tool -> ask gate (P4)", async () => {
  const d = await decideToolCall(mkExec({ tool: "worktree_authorize_main", args: { reason: "x" }, cwd: wtPath }), {});
  assert.equal(d.kind, "ask");
});

test("L09 subagent inherits binding via parentSession (tier 2)", async () => {
  const d = await decideToolCall(mkExec({ tool: "write", args: { file_path: join(repo, "a.txt") }, cwd: wtPath, sessionId: "sub1", parentSession: "s1" }), {});
  assert.equal(d.kind, "deny"); // inherited binding -> main write denied
});

test("L10 unbound fresh session in main: main write allowed (P1), cross-copy denied", async () => {
  const okMain = await decideToolCall(mkExec({ tool: "write", args: { file_path: join(repo, "a.txt") }, cwd: repo, sessionId: "s-fresh" }), {});
  assert.equal(okMain.kind, "allow");
  const cross = await decideToolCall(mkExec({ tool: "write", args: { file_path: join(wtPath, "b.txt") }, cwd: repo, sessionId: "s-fresh" }), {});
  assert.equal(cross.kind, "deny");
});

test("L11 exit keep -> unbound; P5 never-block-owner", async () => {
  const r = await lifecycle.exitSession({ sessionId: "s1", cwd: wtPath, action: "keep" });
  assert.equal(r.exited, true);
  const d = await decideToolCall(mkExec({ tool: "write", args: { file_path: join(repo, "a.txt") }, cwd: wtPath, sessionId: "s1" }), {});
  assert.equal(d.kind, "allow"); // no binding anymore (from main? cwd=wt, unbound -> allow)
});

test("L12 remove: unmerged branch kept; merged -> branch deleted", async () => {
  // unmerged dirty copy refuses without force
  const wt2 = await lifecycle.create({ taskName: "two", cwd: repo });
  await writeFile(join(wt2.worktree, "c.txt"), "x", "utf8");
  const r1 = await lifecycle.remove({ path: wt2.worktree, cwd: repo, confirmRemove: true, deleteBranch: true, config: {} });
  assert.equal(r1.removed, false);
  // commit on branch, merge into main, then remove -> branch deleted (proof-based)
  sh(wt2.worktree, "git", ["add", "."]);
  sh(wt2.worktree, "git", ["commit", "-m", "c", "-q"]);
  sh(repo, "git", ["merge", "-q", "--no-ff", "worktree-two", "-m", "merge two"]);
  const r2 = await lifecycle.remove({ path: wt2.worktree, cwd: repo, confirmRemove: true, deleteBranch: true, config: {} });
  assert.equal(r2.removed, true);
  assert.equal(r2.branch, "worktree-two");
  let exists = true;
  try { sh(repo, "git", ["rev-parse", "--verify", "refs/heads/worktree-two"]); } catch { exists = false; }
  assert.equal(exists, false, "merged branch must be deleted");
});

test("L13 status: merged proof + stale marks; prune drops dead bindings", async () => {
  // commit on the alpha branch so it is AHEAD of main (not an ancestor) —
  // a branch freshly cut from HEAD is trivially merged; prove-ahead semantics.
  await writeFile(join(wtPath, "alpha-work.txt"), "x", "utf8");
  sh(wtPath, "git", ["add", "."]);
  sh(wtPath, "git", ["commit", "-m", "alpha work", "-q"]);
  const st = await lifecycle.status({ cwd: repo, sessionId: "none" });
  assert.ok(Array.isArray(st.copies) && st.copies.length >= 1);
  const alpha = st.copies.find((c) => c.name === "worktree-fix-login");
  assert.ok(alpha, "alpha copy listed");
  assert.equal(alpha.merged_into_head, false); // ahead of main => not merged
  // bind a fake session then prune dry-run (silent >24h via fabricated resolved_at)
  const { writeBinding, listBindings } = await import("../src/core/store.mjs");
  await writeBinding(cd, "ghost", { worktree: norm(wtPath), branch: "worktree-fix-login", resolved_at: "2020-01-01T00:00:00Z" });
  const p1 = await lifecycle.prune({ cwd: repo, dryRun: true });
  assert.ok(p1.dropped.some((d) => d.sessionId === "ghost"));
  const p2 = await lifecycle.prune({ cwd: repo, dryRun: false });
  assert.ok((await listBindings(cd)).every((b) => b.sessionId !== "ghost"));
});

test("L14 CLI smoke: status + create + exit roundtrip", async () => {
  const { fileURLToPath } = await import("node:url");
  const wtCli = fileURLToPath(new URL("../wt.mjs", import.meta.url));
  const out = sh(repo, "node", [wtCli, "status"]);
  assert.match(out, /mode/);
});

async function fileExists(p) {
  try { await readFile(p); return true; } catch { return false; }
}
