// round-16: review-driven hardening regressions.
//   - push net survives git global options / executable names / shell prefixes;
//   - runtime refspec expressions fail closed;
//   - PowerShell backtick+newline continuation cannot split a push segment;
//   - `-o -n` is not a dry run; `-o ci.skip` is a legitimate push option;
//   - read-only `git branch` queries are not lifecycle mutations;
//   - `git -c` is config, not `git -C` retargeting;
//   - quoted paths with spaces are classified correctly;
//   - prunable (externally deleted) worktrees no longer break status/prune/remove;
//   - live sessions are not pruned by age alone; notices stale hint is reachable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePwsh, makeContext } from "../src/core/decision.js";
import * as lifecycle from "../src/core/lifecycle.js";
import { commonDir } from "../src/core/gitops.js";
import { writeBinding, listBindings, readState, stateRoot, updateState, updateStateIf } from "../src/core/store.js";
import { sessionStartText } from "../src/notices.js";
import { norm } from "../src/core/paths.js";
import { MAIN, WT_A, WT_B, COMMON } from "./helpers/fixtures.js";

const ctx = makeContext({
  mainRoot: MAIN,
  commonDir: COMMON,
  worktrees: [{ root: WT_A, name: "worktree-alpha" }, { root: WT_B, name: "worktree-beta" }],
});
const bound = { worktree: WT_A, branch: "worktree-alpha" };
const onCopy = { currentBranchName: "worktree-alpha", cwd: WT_A };
const onMain = { currentBranchName: "master", cwd: MAIN };
const pw = (command) => decidePwsh({ ...onCopy, command }, ctx, bound, {});
const pm = (command) => decidePwsh({ ...onMain, command }, ctx, null, {});

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function makeRepo() {
  const d = await mkdtemp(join(tmpdir(), "wtg-r16-"));
  sh(d, "git", ["init", "-b", "main"]);
  sh(d, "git", ["config", "user.email", "t@t"]);
  sh(d, "git", ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "hello\n", "utf8");
  sh(d, "git", ["add", "."]);
  sh(d, "git", ["commit", "-m", "init", "-q"]);
  return d;
}

test("R16-P1 git 全局选项 / 可执行名 / shell 前缀不能绕过 push 网", () => {
  for (const cmd of [
    "git -C . push origin master",
    "git -C . push -f origin master",
    "git -c core.pager=cat push origin master",
    "git --no-pager push origin master",
    "git --git-dir=.git push origin master",
    "git.exe push origin master",
    "command git push origin master",
    "env FOO=1 git push origin master",
    "FOO=1 git push origin master",
    "time git push origin master",
  ]) {
    assert.equal(pw(cmd).kind, "deny", cmd);
  }
  // A non-protected publish through -C . is still safe (no net touched).
  assert.equal(pw("git -C . push origin feature-x").kind, "allow");
  // Bare push of the bound worktree branch stays allowed even via -C . .
  assert.equal(pw("git -C . push").kind, "allow");
  // Unbound main checkout + force through -C . must not ride the relax path.
  assert.equal(pm("git -C . push -f origin master").kind, "deny");
});

test("R16-P2 运行时拼接/变量 refspec fail-closed", () => {
  for (const cmd of [
    'git push origin ("mas" + "ter")',
    "$b='ma'+'ster'; git push origin $b",
    "git push origin ${branch}",
  ]) {
    assert.equal(pw(cmd).kind, "deny", cmd);
  }
});

test("R16-P3 反引号续行不能把 push 段切断", () => {
  assert.equal(pm("git push `\n--force origin master").kind, "deny");
  assert.equal(pm("git push origin `\n:master").kind, "deny");
  assert.equal(pm("git push origin `\n+master").kind, "deny");
});

test("R16-P4 -o 的值不是 dry-run；-o ci.skip 正常放行", () => {
  assert.equal(pw("git push -o -n origin master").kind, "deny");
  const d = pm("git push -o ci.skip origin master");
  assert.equal(d.kind, "allow");
  assert.equal(d.audit, "allow_protected_push");
});

test("R16-P5 只读 git branch 查询不按生命周期变更拦截", () => {
  assert.equal(pw('git branch --list "worktree-*"').kind, "allow");
  assert.equal(pw('git branch --contains worktree-beta').kind, "allow");
  assert.equal(pw('git branch -d "worktree-beta" --list').kind, "deny");
});

test("R16-P6 git -c 是配置，不是 git -C 定向", () => {
  assert.equal(pm("git -c core.hooksPath=F:/repo/.git/hooks status").kind, "allow");
  assert.equal(pw(`git -C ${MAIN} status`).kind, "deny"); // uppercase -C still netted
});

test("R16-P7 带空格的引号路径按完整路径判域", () => {
  const spaceMain = "F:/repo dir";
  const spaceCopy = "F:/repo dir/.worktrees/worktree one";
  const sctx = makeContext({ mainRoot: spaceMain, commonDir: `${spaceMain}/.git`, worktrees: [{ root: spaceCopy, name: "worktree one" }] });
  const sbound = { worktree: spaceCopy, branch: "worktree-one" };
  const s = { currentBranchName: "worktree-one", cwd: spaceCopy };
  assert.equal(decidePwsh({ ...s, command: `git -C "${spaceMain}" commit -am x` }, sctx, sbound, {}).kind, "deny");
  assert.equal(decidePwsh({ ...s, command: `git -C "${spaceCopy}" status` }, sctx, sbound, {}).kind, "allow");
  const gone = `${spaceMain}/.worktrees/gone dir`;
  const d = decidePwsh({ ...s, command: `git -C "${gone}" status`, missingPaths: new Set([norm(gone)]) }, sctx, sbound, {});
  assert.match(d.reason, /已不存在/);

  // Relative --git-dir / -C target that no longer exists also gets GONE copy.
  const rel = ".worktrees/worktree-gone";
  const relMissing = new Set([norm(rel, WT_A)]);
  const dr = decidePwsh({ ...onCopy, command: `git -C ${rel} status`, missingPaths: relMissing }, ctx, bound, {});
  assert.match(dr.reason, /已不存在/);

  // mainRoot without spaces + copy folder WITH a space: own copy must stay open.
  const flatMain = "F:/repo";
  const flatCopy = "F:/repo/.worktrees/worktree one";
  const fctx = makeContext({ mainRoot: flatMain, commonDir: `${flatMain}/.git`, worktrees: [{ root: flatCopy, name: "worktree one" }] });
  const fbound = { worktree: flatCopy, branch: "worktree-one" };
  assert.equal(decidePwsh({ currentBranchName: "worktree-one", cwd: flatCopy, command: `git -C "${flatCopy}" status` }, fctx, fbound, {}).kind, "allow");
  assert.equal(decidePwsh({ currentBranchName: "worktree-one", cwd: flatCopy, command: `git -C "${flatMain}" status` }, fctx, fbound, {}).kind, "deny");
});

test("R16-P10 脚本块 / 包装器选项 / 引号子命令仍入网", () => {
  assert.equal(pw("& { git push origin master }").kind, "deny");
  assert.equal(pw("if ($true) { git push origin master }").kind, "deny");
  assert.equal(pw('pwsh -NoProfile -Command "git push origin master"').kind, "deny");
  assert.equal(pw('cmd /s /c "git push origin master"').kind, "deny");
  assert.equal(pw('git "checkout" main').kind, "deny"); // quoted argv is still argv
});

test("R16-P11 $( ) 只把替换区间当代码，提交信息不再整体误伤", () => {
  assert.equal(pw('git commit -m "sha $(git rev-parse --short HEAD) (git push origin master)"').kind, "allow");
  assert.equal(pw('git commit -m "$(date); git push origin master"').kind, "allow");
  assert.equal(pw('git commit -m "$(git push origin master)"').kind, "deny");
  assert.equal(pw('Write-Host "pre $(git push origin master) post"').kind, "deny");
});

test("R16-L1 外部删除副本目录后 status/prune 仍可工作（prunable）", async () => {
  const repo = await makeRepo();
  try {
    const cd = await commonDir(repo);
    const r = await lifecycle.create({ taskName: "review prunable", cwd: repo });
    await lifecycle.enter({ path: r.worktree, sessionId: "rev-prune", cwd: r.worktree });
    await rm(r.worktree, { recursive: true, force: true }); // not via git worktree remove
    const st = await lifecycle.status({ cwd: repo, sessionId: "none" });
    const copy = st.copies.find((c) => c.name === "worktree-review-prunable");
    assert.ok(copy && copy.prunable, "prunable copy listed without throwing");
    assert.ok(st.stale_bindings.some((b) => b.sessionId === "rev-prune"));
    const p = await lifecycle.prune({ cwd: repo, dryRun: false });
    assert.ok(p.dropped.some((x) => x.sessionId === "rev-prune"));
    assert.equal((await lifecycle.status({ cwd: repo })).stale_bindings.length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  }
});

test("R16-L1b remove 可回收外部删除的 prunable 副本", async () => {
  const repo = await makeRepo();
  try {
    const cd = await commonDir(repo);
    const r = await lifecycle.create({ taskName: "review remove", cwd: repo });
    await lifecycle.enter({ path: r.worktree, sessionId: "rev-remove", cwd: r.worktree });
    await rm(r.worktree, { recursive: true, force: true });
    const res = await lifecycle.remove({ path: r.worktree, cwd: repo, confirmRemove: true, deleteBranch: true });
    assert.equal(res.removed, true);
    assert.equal((await listBindings(cd)).length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  }
});

test("R16-L2 活会话不会因 entered_at 超阈被 prune", async () => {
  const repo = await makeRepo();
  try {
    const cd = await commonDir(repo);
    const r = await lifecycle.create({ taskName: "review live", cwd: repo });
    await lifecycle.enter({ path: r.worktree, sessionId: "rev-live", cwd: r.worktree });
    const b = (await listBindings(cd)).find((x) => x.sessionId === "rev-live");
    await writeBinding(cd, "rev-live", { ...b, entered_at: "2020-01-01T00:00:00Z" });
    const st = await lifecycle.status({ cwd: repo, sessionId: "none" });
    assert.ok(!st.stale_bindings.some((x) => x.sessionId === "rev-live"), "live session must not be stale");
    assert.equal((await lifecycle.prune({ cwd: repo })).dropped.length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  }
});

test("R16-L3 session-start 过期提示基于 updated_at（不再 Date.parse 路径）", async () => {
  const repo = await makeRepo();
  try {
    const cd = await commonDir(repo);
    const ghost = join(repo, ".worktrees", "worktree-ghost");
    await mkdir(stateRoot(cd), { recursive: true });
    await writeFile(join(stateRoot(cd), "state.json"), JSON.stringify({ last_active: ghost, updated_at: "2020-01-01T00:00:00Z" }), "utf8");
    const text = await sessionStartText({ cwd: repo, sessionId: "nobody" });
    assert.match(text ?? "", /长期未收尾/);
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  }
});

test("R16-L4 prune 审计写失败不把已生效的回收变成错误", async () => {
  const repo = await makeRepo();
  try {
    const cd = await commonDir(repo);
    const r = await lifecycle.create({ taskName: "review audit", cwd: repo });
    await lifecycle.enter({ path: r.worktree, sessionId: "rev-audit", cwd: r.worktree });
    await rm(r.worktree, { recursive: true, force: true });
    await rm(join(stateRoot(cd), "audit.jsonl"), { force: true });
    await mkdir(join(stateRoot(cd), "audit.jsonl"), { recursive: true }); // force appendFile EISDIR
    const p = await lifecycle.prune({ cwd: repo, dryRun: false });
    assert.ok(p.dropped.some((x) => x.sessionId === "rev-audit"));
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  }
});

test("R16-L5 updateStateIf 在互斥内做 CAS，不覆盖并发写入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wtg-r16-state-"));
  try {
    await updateState(dir, { last_active: "gone" });
    const pending = updateStateIf(dir, async (s) => {
      await new Promise((r) => setTimeout(r, 50));
      return s.last_active === "gone";
    }, { last_active: null });
    await new Promise((r) => setTimeout(r, 10));
    await updateState(dir, { last_active: "live" }); // queues behind the predicate
    assert.equal(await pending, true);
    assert.equal((await readState(dir)).last_active, "live");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
