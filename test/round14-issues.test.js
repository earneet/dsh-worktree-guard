// round-14 (0.2.3): regressions for issues #1/#2/#3 and the protected-push
// policy change approved in this round.
//   - #1 / push: an UNBOUND session rooted at the main checkout may publish the
//     CURRENT protected branch (audited); bound sessions, destructive pushes and
//     pushes of another protected branch stay denied; --dry-run is read-only.
//   - #2: a deleted copy path under mainRoot is reported as GONE, not as the
//     main checkout (the old "next step" sent the user into an ENOENT).
//   - #3: status and prune share ONE staleness predicate; status lists stale
//     bindings with a worktree_prune action, and prune clears a dangling
//     state.json.last_active so the two cannot disagree.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePwsh, makeContext } from "../src/core/decision.js";
import { decideToolCall, bustGuardContextCache } from "../src/guard.js";
import * as lifecycle from "../src/core/lifecycle.js";
import { commonDir, removeWorktree } from "../src/core/gitops.js";
import { readState } from "../src/core/store.js";
import { norm } from "../src/core/paths.js";
import { MAIN, WT_A, WT_B, COMMON } from "./helpers/fixtures.js";

// ---------- pure decision table ----------

const ctx = makeContext({
  mainRoot: MAIN,
  commonDir: COMMON,
  worktrees: [{ root: WT_A, name: "worktree-alpha" }, { root: WT_B, name: "worktree-beta" }],
});
const bound = { worktree: WT_A, branch: "worktree-alpha" };
const onMain = { currentBranchName: "master", cwd: MAIN };

test("R14-P1 未绑定 + 根在主 checkout + 推送当前分支 -> allow + audit", () => {
  for (const cmd of [
    "git push origin master",
    "git push",
    "git push origin",
    "git push origin HEAD",
    "git push origin master:master",
    "git push origin HEAD:master",
  ]) {
    const d = decidePwsh({ ...onMain, command: cmd }, ctx, null, {});
    assert.equal(d.kind, "allow", cmd);
    assert.equal(d.audit, "allow_protected_push", cmd);
  }
});

test("R14-P2 --dry-run 在任何状态放行（只读、无远端写）", () => {
  assert.equal(decidePwsh({ ...onMain, command: "git push --dry-run origin master" }, ctx, null, {}).kind, "allow");
  assert.equal(decidePwsh({ ...onMain, command: "git push origin master --dry-run" }, ctx, bound, {}).kind, "allow");
  assert.equal(decidePwsh({ ...onMain, command: "git push -n" }, ctx, bound, {}).kind, "allow");
});

test("R14-P3 绑定会话推送受保护分支仍 deny", () => {
  const d = decidePwsh({ ...onMain, command: "git push origin master" }, ctx, bound, {});
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /绑定副本/);
});

test("R14-P4 破坏性 push 仍 deny（force/lease/delete/all/mirror/+refspec）", () => {
  for (const cmd of [
    "git push -f origin master",
    "git push --force origin master",
    "git push --force-with-lease origin master",
    "git push origin --delete master",
    "git push origin :master",
    "git push origin :HEAD",
    "git push --all",
    "git push --mirror",
    "git push origin +master",
    "git push --receive-pack=evil origin master",
  ]) {
    assert.equal(decidePwsh({ ...onMain, command: cmd }, ctx, null, {}).kind, "deny", cmd);
  }
});

test("R14-P5 非当前分支 / 根不在主 checkout / 未绑定副本 -> deny", () => {
  assert.match(decidePwsh({ ...onMain, command: "git push origin main" }, ctx, null, {}).reason, /当前不在该分支|不是当前分支/);
  assert.equal(decidePwsh({ ...onMain, currentBranchName: "feature-x", command: "git push origin master" }, ctx, null, {}).kind, "deny");
  assert.equal(decidePwsh({ ...onMain, cwd: WT_A, command: "git push origin master" }, ctx, null, {}).kind, "deny");
  // destination is the current branch but the SOURCE is another branch: this
  // rewrites the protected remote ref from elsewhere and must not be relaxed.
  assert.equal(decidePwsh({ ...onMain, command: "git push origin other:master" }, ctx, null, {}).kind, "deny");
  assert.equal(decidePwsh({ ...onMain, command: "git push origin refs/heads/other:refs/heads/master" }, ctx, null, {}).kind, "deny");
  assert.equal(decidePwsh({ ...onMain, command: "git push origin other:HEAD" }, ctx, null, {}).kind, "deny");
});

test("R14-P5b 源与目标都解析到当前分支 -> allow（HEAD/@/refs 形式）", () => {
  for (const cmd of [
    "git push origin @:master",
    "git push origin HEAD:refs/heads/master",
    "git push origin refs/heads/master:refs/heads/master",
    "git push origin master",
  ]) {
    const d = decidePwsh({ ...onMain, command: cmd }, ctx, null, {});
    assert.equal(d.kind, "allow", cmd);
    assert.equal(d.audit, "allow_protected_push", cmd);
  }
});

test("R14-P5c 推非受保护分支不产生保护审计", () => {
  const d = decidePwsh({ ...onMain, command: "git push origin feature-x" }, ctx, null, {});
  assert.equal(d.kind, "allow");
  assert.equal(d.audit, undefined);
});

test("R14-P6 未提供 cwd 时默认行为不变（仍 deny）", () => {
  assert.equal(decidePwsh({ command: "git push origin master", currentBranchName: "master" }, ctx, null, {}).kind, "deny");
  assert.equal(decidePwsh({ command: "git push", currentBranchName: "master" }, ctx, null, {}).kind, "deny");
});

test("R14-P7 复合命令：每一段 push 都必须安全，安全首段不得遮蔽后续真实 push", () => {
  for (const cmd of [
    "git push origin master; git push --dry-run origin master",
    "git push --dry-run; git push origin master",
    "git push origin master; git push origin feature-x",
  ]) {
    const d = decidePwsh({ ...onMain, command: cmd }, ctx, null, {});
    assert.equal(d.kind, "allow", cmd);
    assert.equal(d.audit, "allow_protected_push", cmd);
  }
  for (const cmd of [
    "git push origin master; git push -f origin master",
    "git push origin master && git push --delete origin master",
    "git push --dry-run origin master && git push --delete origin master",
    "git push; git push -f origin master",
    "git push origin master; git branch -D worktree-beta",
  ]) {
    assert.equal(decidePwsh({ ...onMain, command: cmd }, ctx, null, {}).kind, "deny", cmd);
  }
});

test("R14-P8 绑定会话的干跑前缀不能为后续真实 push 开路", () => {
  for (const cmd of [
    "git push --dry-run origin master; git push origin master",
    "git push -n; git push -f origin master",
    'echo x; "git push --dry-run"; git push origin master',
  ]) {
    assert.equal(decidePwsh({ ...onMain, cwd: WT_A, command: cmd }, ctx, bound, {}).kind, "deny", cmd);
  }
});

test("R14-P9 fd 复制重定向（2>&1）不得截断 push 段或吃掉 remote", () => {
  for (const cmd of [
    "git push 2>&1 origin --delete master",
    "git push 2>&1 origin +master",
    "git push 2>&1 origin feature:master",
    "git push -f 2>&1 origin master",
    "git push 2>&1 origin --all",
  ]) {
    assert.equal(decidePwsh({ ...onMain, command: cmd }, ctx, null, {}).kind, "deny", cmd);
  }
  for (const cmd of ["git push 2>&1 origin master", "git push origin master 2>&1"]) {
    const d = decidePwsh({ ...onMain, command: cmd }, ctx, null, {});
    assert.equal(d.kind, "allow", cmd);
    assert.equal(d.audit, "allow_protected_push", cmd);
  }
  assert.equal(decidePwsh({ ...onMain, cwd: WT_A, command: "git push 2>&1 origin master" }, ctx, bound, {}).kind, "deny");
});

// ---------- issue #2: deleted copy path is reported as GONE ----------

const ctxNoCopies = makeContext({ mainRoot: MAIN, commonDir: COMMON, worktrees: [] });

test("R14-M1 已删除副本路径 -> 文案说明“不存在”并指向 status/prune", () => {
  const gone = MAIN + "/.worktrees/worktree-gone";
  const d = decidePwsh({ command: `git -C "${gone}" status`, missingPaths: new Set([norm(gone)]) }, ctxNoCopies, null, {});
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /不存在/);
  assert.match(d.reason, /worktree_status/);
  assert.match(d.reason, /worktree_prune/);
  assert.doesNotMatch(d.reason, /请在目标副本目录内直接执行/);
});

test("R14-M2 存在的副本路径不算“不存在”（不误伤正常定向）", () => {
  const d = decidePwsh({ command: `git -C "${WT_A}" status`, missingPaths: new Set() }, ctx, bound, {});
  assert.equal(d.kind, "allow");
});

// ---------- integration: real repo ----------

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function makeRepo() {
  const d = await mkdtemp(join(tmpdir(), "wtg-r14-"));
  sh(d, "git", ["init", "-b", "main"]);
  sh(d, "git", ["config", "user.email", "t@t"]);
  sh(d, "git", ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "hello\n", "utf8");
  sh(d, "git", ["add", "."]);
  sh(d, "git", ["commit", "-m", "init", "-q"]);
  return d;
}
function mkExec(tool, args, cwd, sessionId) {
  return { name: tool, arguments: args, callId: `r14-${sessionId}-${Math.random()}`, agent: { session: { header: { id: sessionId, cwd, parentSession: null } } } };
}

let repo, cd;
before(async () => {
  repo = await makeRepo();
  cd = await commonDir(repo);
});
after(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

test("R14-I1 未绑定主 checkout 推当前分支 -> allow 且落 allow_protected_push 审计", async () => {
  bustGuardContextCache();
  const d = await decideToolCall(mkExec("pwsh", { command: "git push origin main" }, repo, "i1"), {});
  assert.equal(d.kind, "allow");
  const audit = await readFile(join(cd, "worktree-guard", "audit.jsonl"), "utf8");
  assert.match(audit, /allow_protected_push/);
});

test("R14-I2 绑定会话推主干 deny；未绑定主 checkout 的 force push deny", async () => {
  const r = await lifecycle.create({ taskName: "r14 bind", cwd: repo });
  await lifecycle.enter({ path: r.worktree, sessionId: "i2-bound", cwd: r.worktree });
  bustGuardContextCache();
  assert.equal((await decideToolCall(mkExec("pwsh", { command: "git push origin main" }, r.worktree, "i2-bound"), {})).kind, "deny");
  assert.equal((await decideToolCall(mkExec("pwsh", { command: "git push -f origin main" }, repo, "i2-unbound"), {})).kind, "deny");
});

test("R14-I3 git -C 已删除副本路径 -> 文案含“不存在”且不指向主 checkout", async () => {
  bustGuardContextCache();
  const gone = join(repo, ".worktrees", "worktree-gone");
  const d = await decideToolCall(mkExec("pwsh", { command: `git -C "${gone}" status` }, repo, "i3"), {});
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /不存在/);
  assert.match(d.reason, /worktree_status|worktree_prune/);
  assert.doesNotMatch(d.reason, /指向 主 checkout/);
});

test("R14-I4 status 与 prune 同谓词；prune 后无残留提示", async () => {
  const repo2 = await makeRepo();
  try {
    const cd2 = await commonDir(repo2);
    const r = await lifecycle.create({ taskName: "r14 stale", cwd: repo2 });
    await lifecycle.enter({ path: r.worktree, sessionId: "stale-s", cwd: r.worktree });
    // external deletion — no lifecycle bookkeeping, exactly the report scenario
    await removeWorktree(repo2, r.worktree, { force: true });
    const st = await lifecycle.status({ cwd: repo2, sessionId: "someone-else" });
    const stale = st.stale_bindings.find((b) => b.sessionId === "stale-s");
    assert.ok(stale, "status must list the stale binding");
    assert.match(stale.reason, /不存在/);
    assert.equal(st.stale_state_hint, null, "a binding still references last_active");
    const p = await lifecycle.prune({ cwd: repo2, dryRun: false });
    assert.ok(p.dropped.some((x) => x.sessionId === "stale-s"));
    assert.equal(p.cleared_last_active, true);
    assert.equal((await readState(cd2)).last_active, null);
    const st2 = await lifecycle.status({ cwd: repo2, sessionId: "someone-else" });
    assert.equal(st2.stale_bindings.length, 0);
    assert.equal(st2.stale_state_hint, null);
  } finally {
    await rm(repo2, { recursive: true, force: true }).catch(() => {});
  }
});

test("R14-I5 绑定已被回收、仅剩 last_active 时 prune 也能清理（issue #3 死路）", async () => {
  const repo3 = await makeRepo();
  try {
    const cd3 = await commonDir(repo3);
    const r = await lifecycle.create({ taskName: "r14 ghost", cwd: repo3 });
    await removeWorktree(repo3, r.worktree, { force: true }); // no enter -> no binding
    const st = await lifecycle.status({ cwd: repo3 });
    assert.match(st.stale_state_hint ?? "", /r14-ghost/);
    const p = await lifecycle.prune({ cwd: repo3, dryRun: false });
    assert.equal(p.dropped.length, 0, "no binding to recycle");
    assert.equal(p.cleared_last_active, true, "the informational record is still cleaned");
    assert.equal((await readState(cd3)).last_active, null);
    assert.equal((await lifecycle.status({ cwd: repo3 })).stale_state_hint, null);
  } finally {
    await rm(repo3, { recursive: true, force: true }).catch(() => {});
  }
});
