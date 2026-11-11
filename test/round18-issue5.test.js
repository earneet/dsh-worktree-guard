// round-18 (0.2.4, user feedback): the user rejected the earlier rule (never
// released) that a session must first be rooted at the copy (new workspace /
// new session) before
// anything may be bound. The product goal is "the agent works on the right
// branch", not maximal manual ceremony.
//
// The adoption channel: a copy nested inside the session root is bound IN PLACE
// (`mode:"adopted"`); the sandbox accepts the copy through a RELATIVE path, and
// no shell word ever names an absolute copy path. Contracts under test:
//   - resolveBindingMode: none / rooted / adopted / unadoptable / stale;
//   - adoptWord / adoptPathArg: only boundary-safe rewrites, never escapes;
//   - worktree_enter adopts from a main rooted session (no workspace needed);
//   - guard: adopted binding lifts cross-copy denials, keeps main protected,
//     does NOT lift the danger-full-access net, and reports the discipline grade;
//   - every other session shape keeps the old (rooted / refused) behaviour.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBindingMode, adoptWord, adoptPathArg, copyRelation,
  BINDING_ADOPTED, BINDING_ROOTED, BINDING_NONE,
} from "../src/core/adopt.js";
import { isolationGrade, isolationReasons } from "../src/core/capabilities.js";
import { decideToolCall, takePendingMark, bustGuardContextCache } from "../src/guard.js";
import { toolSpecs } from "../src/wt-tools.js";
import { standingLine } from "../src/notices.js";
import * as lifecycle from "../src/core/lifecycle.js";
import { listWorktrees, currentBranch } from "../src/core/gitops.js";
import { norm } from "../src/core/paths.js";

// ---------- pure: binding mode ----------

const MAIN = "F:/repo";
const COPY = "F:/repo/.worktrees/worktree-x";
const OUTSIDE = "F:/elsewhere/worktree-y";
const ent = (root) => ({ root, prunable: false, locked: false });

test("R18-A1 绑定模式：none / rooted / adopted / unadoptable / stale", () => {
  assert.equal(resolveBindingMode({ binding: null, cwd: MAIN }).kind, BINDING_NONE);
  // session root is the copy
  assert.equal(resolveBindingMode({ binding: { worktree: COPY }, cwd: COPY, entries: [ent(COPY)] }).kind, BINDING_ROOTED);
  // copy nested inside the session root (default layout): ADOPTED, no ceremony
  const adopted = resolveBindingMode({ binding: { worktree: COPY }, cwd: MAIN, entries: [ent(COPY)] });
  assert.equal(adopted.kind, BINDING_ADOPTED);
  assert.equal(adopted.rel, ".worktrees/worktree-x");
  assert.equal(adopted.needsCwdSwitch, false);
  // copy outside the boundary cannot be reached by a relative path
  const outside = resolveBindingMode({ binding: { worktree: OUTSIDE }, cwd: MAIN, entries: [ent(OUTSIDE)] });
  assert.equal(outside.kind, "unadoptable");
  assert.equal(outside.needsCwdSwitch, true);
  // a host-owned copy is restored+entered by the host, never adopted by us
  const hostOwned = resolveBindingMode({ binding: { worktree: COPY }, cwd: MAIN, caps: { worktreeService: true }, entries: [ent(COPY)] });
  assert.equal(hostOwned.kind, "unadoptable");
  assert.match(hostOwned.reason, /host/);
  // prunable (deleted) copy first
  assert.equal(resolveBindingMode({ binding: { worktree: COPY }, cwd: MAIN, entries: [{ root: COPY, prunable: true }] }).kind, "stale");
  // Windows/POSIX path spellings compare through norm(); rel is "/"-normalized
  // (`inside` = the copy is under the session root).
  const relation = copyRelation("F:\\repo", COPY);
  assert.equal(relation.inside, true);
  assert.equal(relation.rel, ".worktrees/worktree-x");
});

test("R18-A2 词级采用只做边界安全的改写：相对→副本内、cd 副本根；绝不发明逃逸", () => {
  const mode = resolveBindingMode({ binding: { worktree: COPY }, cwd: MAIN, entries: [ent(COPY)] });
  assert.equal(adoptWord(".worktrees/worktree-x", mode), norm(COPY)); // bash -c "cd <copy> && …"
  assert.equal(adoptWord(".worktrees/worktree-x/src/a.ts", mode), `${norm(COPY)}/src/a.ts`);
  assert.equal(adoptWord("src/a.ts", mode), null); // not copy-relative: never invented
  assert.equal(adoptWord(".worktrees/worktree-x/../escape", mode), null);
  assert.equal(adoptWord(`${MAIN}/src/a.ts`, mode), null); // absolute stays absolute
  assert.equal(adoptWord("-C", mode), null);
  assert.equal(adoptWord("https://github.com/x/y", mode), null);
  // tool path args: "." (and "") mean "this session's branch" -> the copy root
  assert.equal(adoptPathArg(".worktrees/worktree-x/src/a.ts", mode), `${norm(COPY)}/src/a.ts`);
  assert.equal(adoptPathArg(join(".worktrees", "worktree-x", "src", "a.ts"), mode), `${norm(COPY)}/src/a.ts`);
  assert.equal(adoptPathArg(".", mode), norm(COPY));
  assert.equal(adoptPathArg("src/a.ts", mode), "src/a.ts"); // not copy-relative: untouched
  assert.equal(adoptPathArg(`${MAIN}/a.ts`, mode), `${MAIN}/a.ts`);
  assert.equal(adoptPathArg("src/a.ts", { kind: BINDING_ROOTED, rel: "" }), "src/a.ts");
});

test("R18-A3 采用绑定的隔离等级恒为纪律，且原因点明采用", () => {
  const binding = { worktree: COPY, mode: "adopted" };
  assert.equal(isolationGrade({ mode: "workspace-write", binding, cwd: MAIN }), "disciplinary");
  assert.ok(isolationReasons({ mode: "workspace-write", binding, cwd: MAIN }).includes("adopted-copy-not-root"));
  // rooted unchanged
  assert.equal(isolationGrade({ mode: "workspace-write", binding: { worktree: COPY }, cwd: COPY }), "structural");
});

// ---------- integration: one real repo ----------

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function makeRepo() {
  const d = await mkdtemp(join(tmpdir(), "wtg-r18-"));
  sh(d, "git", ["init", "-b", "main"]);
  sh(d, "git", ["config", "user.email", "t@t"]);
  sh(d, "git", ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "hello\n", "utf8");
  sh(d, "git", ["add", "."]);
  sh(d, "git", ["commit", "-m", "init", "-q"]);
  return d;
}
function mkExec(tool, args, cwd, sessionId) {
  return { name: tool, arguments: args, callId: `r18-${sessionId}-${Math.random()}`, agent: { session: { header: { id: sessionId, cwd, parentSession: null } } } };
}
function helpersFor(cwd, caps, extra = {}) {
  return {
    // the tool layer identifies the session from exec; helpers.sessionOf must
    // agree with mkExec (it used to hardcode one id and silently mis-bind)
    sessionOf: (exec) => {
      const h = exec?.agent?.session?.header ?? {};
      return { id: h.id, cwd: h.cwd ?? cwd, parentSession: null };
    },
    config: async () => ({}),
    hostCapabilities: async () => caps,
    switchSession: async () => ({ ok: false, reason: "host has no worktree service" }),
    ...extra,
  };
}
const specOf = (specs, name) => specs.find((s) => s.name === name);

let repo, copy;
before(async () => {
  repo = await makeRepo();
  copy = (await lifecycle.create({ taskName: "r18 adopt", cwd: repo })).worktree;
});
after(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

test("R18-I1 enter：主 checkout 会话直接采用副本（不再要求先切工作区/新开会话）", async () => {
  const enter = specOf(toolSpecs(helpersFor(repo, { sandboxMode: "workspace-write" })), "worktree_enter");
  const out = await enter.execute({ path: copy }, mkExec("worktree_enter", {}, repo, "adopt-1"));
  assert.equal(out.bound, true, out.reason ?? out.error);
  assert.equal(out.adopted, true);
  assert.equal(out.mode, "adopted");
  assert.equal(out.isolation, "disciplinary");
  // the copy branch is recorded; the session did not move
  assert.ok(out.branch);
  assert.equal(norm(out.session_root), norm(repo));
  const text = enter.output.render({}, out)[0].text;
  assert.match(text, /采用模式/);
  // status reports the adopted mode
  const st = await lifecycle.status({ cwd: repo, sessionId: "adopt-1" });
  assert.equal(st.mode, "adopted");
  // standing line explains the adopted channel
  assert.match(standingLine({ worktree: copy, branch: "worktree-r18-adopt", mode: "adopted" }), /采用模式/);
});

test("R18-I2 采用后：副本内写入放行、主 checkout 写入仍 deny 并给单轮重试路径", async () => {
  bustGuardContextCache();
  const opts = {
    sandboxModeOf: () => "workspace-write",
    hostCapabilitiesOf: async () => ({ workspaceRegistry: true, directoryPicker: true, sandboxMode: "workspace-write" }),
  };
  // writing INSIDE the copy through an absolute path is no longer "cross-copy"
  const inside = await decideToolCall(mkExec("write", { file_path: join(copy, "src", "new.ts") }, repo, "adopt-1"), opts);
  assert.equal(inside.kind, "allow", inside.reason);
  // a relative path that lands on MAIN is denied, and the deny names the
  // copy-prefixed retry path (single-turn executable — C1 forbids rewrites)
  const mainWrite = await decideToolCall(mkExec("write", { file_path: join(repo, "src", "a.ts") }, repo, "adopt-1"), opts);
  assert.equal(mainWrite.kind, "deny");
  assert.match(mainWrite.reason, /主 checkout/);
  assert.match(mainWrite.reason, /采用模式/);
  assert.match(mainWrite.reason, /\.worktrees[/\\]worktree-r18-adopt[/\\]src[/\\]a\.ts/);
  // another copy is still denied
  const other = await lifecycle.create({ taskName: "r18 other", cwd: repo });
  const otherWrite = await decideToolCall(mkExec("write", { file_path: join(other.worktree, "x.ts") }, repo, "adopt-1"), opts);
  assert.equal(otherWrite.kind, "deny");
  assert.match(otherWrite.reason, /跨副本/);
  // shell: the relative copy word is read against the copy BEFORE the decision,
  // so `bash -c "cd <copy> && …"` is judged where it actually runs (allow+mark),
  // while a protected push inside that same routing is still denied.
  const benign = mkExec("bash", { command: "bash -c 'cd .worktrees/worktree-r18-adopt && git status --porcelain'" }, repo, "adopt-1");
  assert.equal((await decideToolCall(benign, opts)).kind, "allow");
  assert.match(takePendingMark(benign.callId) ?? "", /采用模式/);
  const routedWrite = "bash -c 'cd .worktrees/worktree-r18-adopt && git push origin main'";
  assert.equal((await decideToolCall(mkExec("bash", { command: routedWrite }, repo, "adopt-1"), opts)).kind, "deny");
  // an unrelated relative command is untouched (no invented routing)
  const plain = await decideToolCall(mkExec("bash", { command: "git status --porcelain" }, repo, "adopt-1"), opts);
  assert.equal(plain.kind, "allow");
  assert.equal(takePendingMark(plain.callId), null);
});

test("R18-I3 采用不解锁 C9：danger-full-access 下绑定会话仍 deny", async () => {
  const d = await decideToolCall(mkExec("write", { file_path: join(copy, "x.ts") }, repo, "adopt-1"), {
    sandboxModeOf: () => "danger-full-access",
    hostCapabilitiesOf: async () => ({}),
  });
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /danger-full-access/);
});

test("R18-I4 副本在会话根之外：拒绝绑定并给出宿主侧路径（不允许无边界改写）", async () => {
  const outsideRepo = await makeRepo();
  try {
    const elsewhere = await mkdtemp(join(tmpdir(), "wtg-r18-out-"));
    const wt = join(elsewhere, "copy");
    sh(outsideRepo, "git", ["worktree", "add", "-b", "outside-branch", wt, "main"]);
    const enter = specOf(toolSpecs(helpersFor(outsideRepo, { sandboxMode: "workspace-write" })), "worktree_enter");
    const out = await enter.execute({ path: wt }, mkExec("worktree_enter", {}, outsideRepo, "outside"));
    assert.equal(out.bound, false);
    assert.match(out.reason, /不在会话根之内/);
    const text = enter.output.render({}, out)[0].text;
    assert.match(text, /下一步/);
    await rm(elsewhere, { recursive: true, force: true }).catch(() => {});
  } finally {
    await rm(outsideRepo, { recursive: true, force: true }).catch(() => {});
  }
});

test("R18-I5 rooted 会话行为不变：enter 直接绑定，模式为 rooted", async () => {
  const enter = specOf(toolSpecs(helpersFor(copy, { sandboxMode: "workspace-write" })), "worktree_enter");
  const out = await enter.execute({ path: copy }, mkExec("worktree_enter", {}, copy, "rooted-1"));
  assert.equal(out.bound, true);
  assert.equal(out.adopted, undefined);
  assert.equal(out.isolation, "structural");
  const st = await lifecycle.status({ cwd: copy, sessionId: "rooted-1" });
  assert.equal(st.mode, "rooted");
  const { entries } = await listWorktrees(repo);
  assert.ok(entries.some((e) => norm(e.root) === norm(copy)));
  assert.equal(await currentBranch(copy), "worktree-r18-adopt");
});
