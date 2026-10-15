// round-8 hardening regressions: (a) shell-net normalization seam (nested
// executors, quote/backtick splices, newline/paren separators) with
// false-positive guards; (b) C8 agent/disposed binding recycle via apply();
// (c) junction strip-before-remove (design §12) incl. untracked-link dirty
// semantics in isDirtyForLifecycle.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, symlink, lstat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePwsh, normalizePwshCommand } from "../src/core/decision.mjs";
import * as lifecycle from "../src/core/lifecycle.mjs";
import { isDirtyForLifecycle } from "../src/core/gitops.mjs";
import { apply } from "../src/index.mjs";
import { commonDir } from "../src/core/gitops.mjs";
import { readBinding } from "../src/core/store.mjs";
import { P } from "./helpers/fixtures.mjs";

const CTX = {
  mainRoot: P("C:/repo"), commonDir: P("C:/repo/.git"),
  worktrees: [{ root: P("C:/repo/.worktrees/worktree-x"), name: "worktree-x" }],
  protectedBranches: ["master", "main"], branchPrefix: "worktree-",
};
const BIND = { worktree: P("C:/repo/.worktrees/worktree-x"), branch: "worktree-x" };
const d = (command) => decidePwsh({ command, currentBranchName: "worktree-x" }, CTX, BIND, {});
const isDeny = (r) => r.kind === "deny";

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "wtg-r8-"));
  sh(dir, "git", ["init", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "t@t"]);
  sh(dir, "git", ["config", "user.name", "t"]);
  await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-m", "init", "-q"]);
  return dir;
}

let repo;

before(async () => { repo = await makeRepo(); });
after(async () => { await rm(repo, { recursive: true, force: true }).catch(() => {}); });

// ---------- R8-A 词法网归一化 seam：绕过变体全部入网 ----------

test("R8-A1 cmd /c 包装的 push 受保护分支 -> deny", () => {
  assert.ok(isDeny(d('cmd /c "git push origin main"')));
});
test("R8-A2 iex 动态执行 push 受保护分支 -> deny", () => {
  assert.ok(isDeny(d("iex 'git push origin main'")));
});
test("R8-A3 pwsh -Command 包装 -> deny", () => {
  assert.ok(isDeny(d('pwsh -Command "git push origin main"')));
});
test("R8-A4 空引号拼接 git pus\"\"h -> deny", () => {
  assert.ok(isDeny(d('git pus""h origin main')));
});
test("R8-A5 反引号转码拼接 git pu`sh -> deny", () => {
  assert.ok(isDeny(d("git pu`sh origin main")));
});
test("R8-A6 子表达式 $(git push origin main) -> deny", () => {
  assert.ok(isDeny(d("Write-Host ($(git push origin main))")));
});
test("R8-A7 多行脚本第二行 push 受保护分支 -> deny", () => {
  assert.ok(isDeny(d("npm run build\ngit push origin main")));
});
test("R8-A8 cmd /c 包装的 checkout main（绑定态）-> deny", () => {
  assert.ok(isDeny(d('cmd /c "git checkout main"')));
});
test("R8-A9 iex 包装的删 worktree 分支 -> deny", () => {
  assert.ok(isDeny(d("iex 'git branch -d worktree-x'")));
});

// ---------- R8-B 误报防线（可用性方向必须不回退） ----------

test("R8-B1 echo 含 push 字样（非命令位）-> allow", () => {
  assert.equal(d('Write-Host "run git push origin main first"').kind, "allow");
});
test("R8-B2 commit 信息含 push 字样 -> allow", () => {
  assert.equal(d('git commit -m "docs: explain git push origin main"').kind, "allow");
});
test("R8-B3 cmd /c 包装的只读 git status -> allow", () => {
  assert.equal(d('cmd /c "git status"').kind, "allow");
});
test("R8-B4 push 本分支（无受保护名）-> allow", () => {
  assert.equal(d("git push origin worktree-x").kind, "allow");
});
test("R8-B5 normalizePwshCommand 折叠嵌套执行器为分隔符", () => {
  assert.match(normalizePwshCommand('cmd /c "git push origin main"'), /;\s*git push origin main/);
  assert.equal(normalizePwshCommand("git pu`sh"), "git push");
});

// ---------- R8-C C8：agent/disposed 盖章回收（经 apply 装配层） ----------

test("R8-C1 agent/disposed 为本会话绑定盖 resolved_at，且幂等不删", async () => {
  const r = await lifecycle.create({ taskName: "r8 dispose", cwd: repo });
  await lifecycle.enter({ path: r.worktree, sessionId: "s-dispose", cwd: r.worktree });
  const cd = await commonDir(r.worktree);

  const handlers = {};
  const mockCtx = { on: (name, fn) => { handlers[name] = fn; }, tools: { register() {} } };
  apply(mockCtx, {});
  assert.equal(typeof handlers["agent/disposed"], "function", "apply 必须注册 agent/disposed 监听");

  await handlers["agent/disposed"]({ agent: { session: { header: { id: "s-dispose", cwd: r.worktree } } } });
  const stamped = await readBinding(cd, "s-dispose");
  assert.ok(stamped?.worktree && stamped.resolved_at, "绑定被盖章而非删除（resume 友好，prune 终删）");

  const first = stamped.resolved_at;
  await new Promise((res) => setTimeout(res, 5));
  await handlers["agent/disposed"]({ agent: { session: { header: { id: "s-dispose", cwd: r.worktree } } } });
  assert.equal((await readBinding(cd, "s-dispose")).resolved_at, first, "幂等：不重复盖章");

  // 无 cwd / 无绑定 / 非 git 目录：全部静默（emit 监听不得抛）
  await assert.doesNotReject(handlers["agent/disposed"]({ agent: { session: { header: { id: "x" } } } }));
  await assert.doesNotReject(handlers["agent/disposed"]({}));
  await lifecycle.remove({ path: r.worktree, cwd: repo, confirmRemove: true });
});

// ---------- R8-D junction 摘链删除（design §12） ----------

test("R8-D1 symlink_dirs 建链 + 未声明 rogue 链，remove 摘链不穿透，主根文件完好", async () => {
  // sidecar: sync.symlink_dirs；主根建目标目录与内容
  await mkdir(join(repo, ".dsh"), { recursive: true });
  await writeFile(join(repo, ".dsh", "worktree-guard.json"), JSON.stringify({ sync: { symlink_dirs: ["shared-assets"] } }), "utf8");
  await mkdir(join(repo, "shared-assets"), { recursive: true });
  await writeFile(join(repo, "shared-assets", "keep.txt"), "precious\n", "utf8");
  await mkdir(join(repo, "rogue-target"), { recursive: true });
  await writeFile(join(repo, "rogue-target", "keep2.txt"), "precious2\n", "utf8");

  const r = await lifecycle.create({ taskName: "r8 links", cwd: repo });
  const wt = r.worktree;
  // 声明的链由 create 建立；rogue 链模拟用户手工/恶意未声明 junction
  await symlink(join(repo, "rogue-target"), join(wt, "rogue"), "junction").catch(() => {});
  assert.ok((await lstat(join(wt, "shared-assets"))).isSymbolicLink(), "声明链存在");
  assert.ok((await lstat(join(wt, "rogue"))).isSymbolicLink(), "rogue 链存在");

  // 未跟踪链接不算脏（round-8 语义）：免 force 可 remove
  assert.equal(await isDirtyForLifecycle(wt), false, "未跟踪 symlink/junction 不计脏");
  const out = await lifecycle.remove({ path: wt, cwd: repo, confirmRemove: true });
  assert.equal(out.removed, true);

  // 穿透验证：主根两侧目标内容完好，副本已删
  await access(join(repo, "shared-assets", "keep.txt"));
  await access(join(repo, "rogue-target", "keep2.txt"));
  await assert.rejects(access(wt));
});

test("R8-D2 用户未跟踪真实文件仍计脏（ignore 名单不得掩蔽真实工作）", async () => {
  const r = await lifecycle.create({ taskName: "r8 dirty", cwd: repo });
  await writeFile(join(r.worktree, "user-note.txt"), "mine\n", "utf8");
  assert.equal(await isDirtyForLifecycle(r.worktree), true);
  const out = await lifecycle.remove({ path: r.worktree, cwd: repo, confirmRemove: true });
  assert.equal(out.removed, false, "脏副本必须被闸门拒绝");
  await lifecycle.remove({ path: r.worktree, cwd: repo, confirmRemove: true, config: { force: true } });
});
