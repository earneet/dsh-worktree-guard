// Round-1 adversarial review regressions + §7 copy-contract tests.
// Each test encodes one finding so it can never silently return.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWrite, decidePwsh, decideRead, makeContext } from "../src/core/decision.mjs";
import { decideToolCall, takePendingMark } from "../src/guard.mjs";
import { standingLine, sessionStartText } from "../src/notices.mjs";
import { updateState, addAllowEntry, readAllowlist } from "../src/core/store.mjs";
import { commonDir } from "../src/core/gitops.mjs";
import { norm } from "../src/core/paths.mjs";

const MAIN = "F:/repo";
const WT_A = "F:/repo/.worktrees/worktree-alpha";
const WT_B = "F:/repo/.worktrees/worktree-beta";
const COMMON = "F:/repo/.git";
const ctx = makeContext({ mainRoot: MAIN, commonDir: COMMON, worktrees: [{ root: WT_A, name: "worktree-alpha" }, { root: WT_B, name: "worktree-beta" }] });
const bound = { worktree: WT_A, branch: "worktree-alpha" };
const authed = { authorize: { allow_main_writes: true, allow_expires_at: new Date(Date.now() + 60_000).toISOString() }, allowlist: {} };

// ---- blocker: deny survives audit failure (integration-level below) + git-meta in residual rule ----

test("RG1 blocker: command targeting .git absolute path denied while bound (was: only main checked)", () => {
  const d = decidePwsh({ command: `New-Item -Type File ${COMMON}/worktree-guard/audit.jsonl` }, ctx, bound);
  assert.equal(d.kind, "deny");
});

// ---- major: branch deletion flag variants ----

test("RG2 major: git branch flag variants all resolve the real branch token", () => {
  for (const cmd of [
    "git branch -d -f worktree-beta",
    "git branch --force --delete worktree-beta",
    "git branch -f -D worktree-beta",
    "git branch --delete -f worktree-beta",
    "git branch -D worktree-alpha",
  ]) {
    assert.equal(decidePwsh({ command: cmd }, ctx, bound).kind, "deny", `must deny: ${cmd}`);
  }
  // non-worktree branch deletion stays allowed
  assert.equal(decidePwsh({ command: "git branch -d -f feature-x" }, ctx, bound).kind, "allow");
});

// ---- major: authorization wiring ----

test("RG3 major: valid authorize grant lifts main-write deny; expired/missing does not", () => {
  assert.equal(decideWrite(MAIN + "/a.txt", WT_A, ctx, bound, authed).kind, "allow");
  assert.equal(decideWrite(MAIN + "/a.txt", WT_A, ctx, bound, { authorize: null }).kind, "deny");
  assert.equal(decideWrite(MAIN + "/a.txt", WT_A, ctx, bound, {}).kind, "deny");
});

test("RG4 major: allowlist entry lifts main-write deny for its subtree only", () => {
  const a = { allowlist: { [norm(MAIN + "/docs")]: { expires_at: "x" } } };
  assert.equal(decideWrite(MAIN + "/docs/a.md", WT_A, ctx, bound, a).kind, "allow");
  assert.equal(decideWrite(MAIN + "/src/a.ts", WT_A, ctx, bound, a).kind, "deny");
});

test("RG5 major: authorize grant lifts protected push; nothing else", () => {
  assert.equal(decidePwsh({ command: "git push origin main" }, ctx, bound, authed).kind, "allow");
  assert.equal(decidePwsh({ command: `git -C ${MAIN} status` }, ctx, bound, authed).kind, "deny");
});

// ---- minor: compound command nets ----

test("RG6 minor: checkout to protected while bound denied; -C relative escape denied", () => {
  assert.equal(decidePwsh({ command: "cd ../..; git checkout main; git push" , currentBranchName: "worktree-alpha" }, ctx, bound).kind, "deny");
  assert.equal(decidePwsh({ command: "git -C ../.. status" }, ctx, bound).kind, "deny");
  assert.equal(decidePwsh({ command: "git -C ../.. status" }, ctx, null).kind, "allow"); // unbound: host semantics
});

// ---- §7 copy contract ----

test("CC1 §7: deny messages are three-part, prefixed, single-turn actionable", () => {
  for (const d of [
    decideWrite(MAIN + "/a.txt", WT_A, ctx, bound),
    decidePwsh({ command: "git push origin main" }, ctx, bound),
    decideRead(MAIN + "/a.txt", WT_A, ctx, bound, { readPolicy: "strict" }),
  ]) {
    assert.equal(d.kind, "deny");
    const lines = d.reason.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^\[worktree-guard\] 已阻止/);
    assert.match(lines[1], /^原因：/);
    assert.match(lines[2], /^下一步：/);
    assert.ok(!/阅读文档/.test(d.reason), "must not point at docs");
  }
});

test("CC2 §7: standing line is exactly 1 line; marker is 1 line", () => {
  assert.equal(standingLine(bound).split("\n").length, 1);
  const m = decideRead(MAIN + "/a.txt", WT_A, ctx, bound).mark;
  assert.equal(m.split("\n").length, 1);
  assert.match(m, /^\[worktree-guard\] /);
});

test("CC3 §7: deny messages never mention regex/matching rules", () => {
  const ds = [
    decidePwsh({ command: "git push origin main" }, ctx, bound),
    decidePwsh({ command: "git -C ../.. x" }, ctx, bound),
    decidePwsh({ command: "git branch -D worktree-beta" }, ctx, bound),
  ];
  for (const d of ds) assert.ok(!/正则|regex|规则|匹配/i.test(d.reason));
});

// ---- integration: blocker scenario + mark pipeline + glob/grep + bash ----

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function mkExec({ tool, args, cwd, sessionId = "s1", parentSession = null }) {
  return {
    name: tool, arguments: args, callId: `c${Math.random().toString(36).slice(2)}`,
    agent: { session: { header: { id: sessionId, cwd, parentSession } } },
  };
}

let repo, wt, cd;
test("RG7 integration: audit sabotage does not weaken the net (blocker)", async () => {
  const d = await mkdtemp(join(tmpdir(), "wtg-r1-"));
  repo = d;
  sh(d, "git", ["init", "-b", "main"]);
  sh(d, "git", ["config", "user.email", "t@t"]); sh(d, "git", ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "x"); sh(d, "git", ["add", "."]); sh(d, "git", ["commit", "-m", "i", "-q"]);
  const lc = await import("../src/core/lifecycle.mjs");
  const r = await lc.create({ taskName: "alpha", cwd: d });
  wt = r.worktree;
  cd = await commonDir(wt);
  // bind via rooted session
  await lc.enter({ path: wt, sessionId: "s1", cwd: wt });
  // sabotage: replace audit.jsonl (a file by now) with a DIRECTORY so appends throw
  const { rm: rmF } = await import("node:fs/promises");
  await rmF(join(cd, "worktree-guard", "audit.jsonl"), { force: true });
  await mkdir(join(cd, "worktree-guard", "audit.jsonl"), { recursive: true });
  // the two-step attack from round 1: deny must still hold for push and -C
  assert.equal((await decideToolCall(mkExec({ tool: "pwsh", args: { command: "git push origin main" }, cwd: wt }), {})).kind, "deny");
  assert.equal((await decideToolCall(mkExec({ tool: "pwsh", args: { command: `git -C ${d} status` }, cwd: wt }), {})).kind, "deny");
  // and the sabotage itself (writing into .git) is denied by the residual rule now
  assert.equal((await decideToolCall(mkExec({ tool: "pwsh", args: { command: `New-Item -Type File ${norm(cd)}/worktree-guard/x` }, cwd: wt }), {})).kind, "deny");
});

test("RG8 mark pipeline: read AND glob/grep main -> pending mark retrievable by callId", async () => {
  const exec1 = mkExec({ tool: "read", args: { file_path: join(repo, "a.txt") }, cwd: wt });
  await decideToolCall(exec1, { readPolicy: "warn" });
  assert.match(takePendingMark(exec1.callId), /主 checkout/);
  const exec2 = mkExec({ tool: "grep", args: { pattern: "x", path: join(repo, "a.txt") }, cwd: wt });
  await decideToolCall(exec2, { readPolicy: "warn" });
  assert.match(takePendingMark(exec2.callId), /主 checkout/);
  const exec3 = mkExec({ tool: "glob", args: { pattern: "*.txt", path: repo }, cwd: wt });
  await decideToolCall(exec3, { readPolicy: "warn" });
  assert.match(takePendingMark(exec3.callId), /主 checkout/);
  // own-copy search: no mark
  const exec4 = mkExec({ tool: "glob", args: { pattern: "*.txt", path: wt }, cwd: wt });
  await decideToolCall(exec4, { readPolicy: "warn" });
  assert.equal(takePendingMark(exec4.callId), null);
});

test("RG9 bash tool name covered by shell net", async () => {
  const d = await decideToolCall(mkExec({ tool: "bash", args: { command: "git push origin main" }, cwd: wt }), {});
  assert.equal(d.kind, "deny");
});

test("RG10 authorize grant read from state end-to-end", async () => {
  await updateState(cd, { allow_main_writes: { allow_main_writes: true, allow_reason: "test", allow_at: new Date().toISOString(), allow_expires_at: new Date(Date.now() + 60_000).toISOString() } });
  assert.equal((await decideToolCall(mkExec({ tool: "pwsh", args: { command: "git push origin main" }, cwd: wt }), {})).kind, "allow");
  assert.equal((await decideToolCall(mkExec({ tool: "write", args: { file_path: join(repo, "a.txt") }, cwd: wt }), {})).kind, "allow");
  // expired grant re-tightens
  await updateState(cd, { allow_main_writes: { allow_main_writes: true, allow_expires_at: "2000-01-01T00:00:00Z" } });
  assert.equal((await decideToolCall(mkExec({ tool: "pwsh", args: { command: "git push origin main" }, cwd: wt }), {})).kind, "deny");
});

test("RG11 allowlist add via store lifts exact subtree (P4 grant consumed)", async () => {
  await addAllowEntry(cd, { path: "docs", reason: "test", ttlMinutes: 5, grantedBy: "test", mainRoot: norm(repo) });
  const entries = (await readAllowlist(cd)).entries;
  assert.ok(Object.keys(entries).includes(norm(join(repo, "docs"))), "key must be repo-absolute");
});

test("RG12 session-start text: clean repo -> null; bound session -> guidance", async () => {
  // restore audit.jsonl from the RG7 sabotage so lifecycle.enter can audit again
  const { rm: rmF } = await import("node:fs/promises");
  await rmF(join(cd, "worktree-guard", "audit.jsonl"), { recursive: true, force: true });
  // clean: fresh temp repo without bindings/state
  const d2 = await mkdtemp(join(tmpdir(), "wtg-r1b-"));
  sh(d2, "git", ["init", "-b", "main"]);
  assert.equal(await sessionStartText({ cwd: d2, sessionId: "none" }), null);
  await rm(d2, { recursive: true, force: true }).catch(() => {});
  // bound rooted session in the main fixture (bind s2 at wt)
  const lc = await import("../src/core/lifecycle.mjs");
  await lc.enter({ path: wt, sessionId: "s2", cwd: wt });
  const t = await sessionStartText({ cwd: wt, sessionId: "s2" });
  assert.match(t, /本副本/);
  assert.match(t, /worktree_authorize_main/); // copy review: 收尾链必须点名授权工具
  assert.match(t, /task-brief/);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true }).catch(() => {});
});
