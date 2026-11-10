// round-15 (0.2.3 residual, issue #1): the detection view must distinguish CODE
// from quoted DATA. Commit messages / host output commonly mention push commands
// verbatim — `git commit -m "(git push origin master)"` used to trip the lexical
// net because quote stripping turned the literal `(` into a command separator.
// These regressions pin BOTH directions: quoted data is allowed, real execution
// paths (substitution, wrappers, multiline, splicing, argv refspecs) still deny.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePwsh, makeContext, normalizePwshCommand } from "../src/core/decision.js";
import { MAIN, WT_A, WT_B, COMMON } from "./helpers/fixtures.js";

const ctx = makeContext({
  mainRoot: MAIN,
  commonDir: COMMON,
  worktrees: [{ root: WT_A, name: "worktree-alpha" }, { root: WT_B, name: "worktree-beta" }],
});
// Bound session: if the payload were mistaken for code, the protected-branch
// push rule would fire and deny. Allowing proves it stayed DATA.
const bound = { worktree: WT_A, branch: "worktree-alpha" };
const onCopy = { currentBranchName: "worktree-alpha", cwd: WT_A };
const pw = (command) => decidePwsh({ command, ...onCopy }, ctx, bound, {});

// ---------- quoted data is not a command position ----------

test("R15-Q1 提交信息括号内提及 push -> allow", () => {
  for (const cmd of [
    'git commit -m "(git push origin master)"',
    'git commit -m "fix: (git push origin master) later"',
    "git commit -m 'docs (git push origin master)'",
  ]) {
    assert.equal(pw(cmd).kind, "allow", cmd);
  }
});

test("R15-Q2 提交信息内的分号/&& 不产生命令分隔 -> allow", () => {
  for (const cmd of [
    'git commit -m "fix; git push origin master"',
    'git commit -m "fix && git push origin master"',
    'git commit -m "fix | git push origin master"',
    'git commit -m "line1\ngit push origin master"',
    'git commit -m "iex" "a; git push origin master"', // quoted `iex` must not arm wrapper detection
  ]) {
    assert.equal(pw(cmd).kind, "allow", cmd);
  }
});

test("R15-Q3 宿输出文本里出现 (git push ...) -> allow", () => {
  assert.equal(pw('Write-Host "run (git push origin master) later"').kind, "allow");
  assert.equal(pw('echo "see (git push origin master)"').kind, "allow");
});

test("R15-Q4 normalizePwshCommand 不再把引号内 ( 当分隔符", () => {
  const v = normalizePwshCommand('git commit -m "(git push origin master)"');
  assert.ok(!v.includes("(git push"), v);
  assert.match(v, /git commit -m .*git push origin master/);
});

// ---------- real execution paths must stay denied ----------

test("R15-E1 $(...) 命令替换仍 deny（即使位于双引号内）", () => {
  assert.equal(pw('git commit -m "$(git push origin master)"').kind, "deny");
  assert.equal(pw('Write-Host "$(git push origin master)"').kind, "deny");
});

test("R15-E2 独立括号表达式（真实执行）仍 deny", () => {
  assert.equal(pw("(git push origin master)").kind, "deny");
});

test("R15-E3 包装器的引号参数是代码：cmd /c、bash -c、pwsh -Command、iex、eval", () => {
  for (const cmd of [
    'cmd /c "echo; git push origin master"',
    'bash -c "echo; git push origin master"',
    'sh -c "echo; git push origin master"',
    'pwsh -Command "echo; git push origin master"',
    "iex 'echo; git push origin master'",
    "eval 'echo; git push origin master'",
  ]) {
    assert.equal(pw(cmd).kind, "deny", cmd);
  }
});

test("R15-E4 多行脚本 / 分段 / 引号拼接仍 deny", () => {
  assert.equal(pw("npm run build\ngit push origin master").kind, "deny");
  assert.equal(pw('git commit -m "x" && git push origin master').kind, "deny");
  assert.equal(pw('git commit -m "x"; git push origin master').kind, "deny");
  assert.equal(pw('git pus""h origin master').kind, "deny");
  assert.equal(pw("git pu`sh origin master").kind, "deny");
});

test("R15-E6 脚本宿主的引号参数按代码检测（不回退旧检测面）", () => {
  for (const cmd of [
    'node -e "git push origin master"',
    'node --no-warnings -e "git push origin master"',
    "python -c \"import os; os.system('git push origin master')\"",
    "perl -e 'system(\"git push origin master\")'",
    "ruby -e 'system(\"git push origin master\")'",
    "php -r 'system(\"git push origin master\");'",
  ]) {
    assert.equal(pw(cmd).kind, "deny", cmd);
  }
  assert.equal(pw('node -e "console.log(1)"').kind, "allow");
});

test("R15-E7 引号数据里的脚本宿主字样不被误判", () => {
  assert.equal(pw("git commit -m \"node -e 'git push origin master'\"").kind, "allow");
  assert.equal(pw("git commit -m \"bash -c 'git push origin master'\"").kind, "allow");
  assert.equal(pw('echo node -e "git push origin master"').kind, "allow");
  assert.equal(pw('echo eval "git push origin master"').kind, "allow");
});

test("R15-E5 参数级检测不回退：带引号的 refspec / 分支名仍生效", () => {
  assert.equal(pw('git push origin "master"').kind, "deny");
  assert.equal(pw('git push origin "HEAD:master"').kind, "deny");
  assert.equal(pw('git branch -d "worktree-beta"').kind, "deny");
  assert.equal(pw('git checkout "main"').kind, "deny");
});
