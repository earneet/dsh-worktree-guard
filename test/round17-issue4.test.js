// round-17 (0.2.4): issue #4 — the "root a new session at the copy" guidance was
// unreachable on hosts whose GUI has no such entry, and the only remaining path
// (absolute paths from a main-rooted session) silently degraded structural
// isolation to discipline. Contracts under test:
//   - guidance is graded by PROBED host capabilities (no unverifiable advice);
//   - the discipline grade is named up front (create render, session start) and
//     reported by worktree_status (isolation / isolation_reasons / next_actions);
//   - worktree_enter{switch_session:true} uses the host's workingDirectory.set
//     (the one in-session move that exists) and never claims the boundary moved;
//   - under a FENCED sandbox the write/shell denies stop prescribing the very
//     absolute-path write the sandbox refuses, exactly once per deny.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  structuralFence, fenceLabel, sessionRootPath, isolationGrade, isolationNote, isolationReasons,
  nextIsolationSteps, withPathTypedRoute, probeHostCapabilities, fenceRecoveryLine,
  FENCE_MARKER, ISOLATION_STRUCTURAL, ISOLATION_DISCIPLINARY,
} from "../src/core/capabilities.js";
import { decideWrite, makeContext } from "../src/core/decision.js";
import { decideToolCall } from "../src/guard.js";
import { toolSpecs } from "../src/wt-tools.js";
import { sessionStartText } from "../src/notices.js";
import * as lifecycle from "../src/core/lifecycle.js";
import { commonDir } from "../src/core/gitops.js";
import { MAIN, WT_A, WT_B, COMMON } from "./helpers/fixtures.js";

// ---------- pure: fence + grade ----------

test("R17-C1 结构性写围栏只认已探测的模式（未知 != 不安全，danger 无围栏）", () => {
  assert.equal(structuralFence("danger-full-access"), null);
  assert.equal(structuralFence("workspace-write"), "workspace-write");
  assert.equal(structuralFence("read-only"), "read-only");
  assert.equal(structuralFence(undefined), undefined);
  assert.match(fenceLabel("danger-full-access"), /无写围栏/);
  assert.match(fenceLabel("workspace-write"), /围栏/);
  assert.match(fenceLabel("read-only"), /只读/);
});

test("R17-C2 隔离等级：绑定且根在副本 + 有围栏 = 结构；其余一律纪律", () => {
  const bound = { worktree: WT_A };
  assert.equal(isolationGrade({ mode: "workspace-write", binding: bound, cwd: WT_A }), ISOLATION_STRUCTURAL);
  // danger-full-access has no fence, so even a correctly rooted copy is discipline
  assert.equal(isolationGrade({ mode: "danger-full-access", binding: bound, cwd: WT_A }), ISOLATION_DISCIPLINARY);
  // a binding that is not the session root reads the main world -> discipline
  assert.equal(isolationGrade({ mode: "workspace-write", binding: bound, cwd: MAIN }), ISOLATION_DISCIPLINARY);
  assert.equal(isolationGrade({ mode: "workspace-write", binding: null, cwd: WT_A }), ISOLATION_DISCIPLINARY);
  // unknown mode is not provably unfenced: a correctly rooted copy stays structural
  // (the guard must not narrow its own claim past what it can observe)
  assert.equal(isolationGrade({ binding: bound, cwd: WT_A }), ISOLATION_STRUCTURAL);
  assert.ok(isolationReasons({ binding: bound, cwd: WT_A }).includes("sandbox-mode-unknown"));
});

test("R17-C3 叙事文案点名等级，副本已存在但未绑定时不得暗示已隔离", () => {
  const note = isolationNote({ grade: ISOLATION_DISCIPLINARY, mode: "workspace-write", copiesUnbound: true });
  assert.match(note, /隔离等级：纪律/);
  assert.match(note, /未绑定/);
  // an unfenced sandbox is the dominant cause and is named as such
  const risky = isolationNote({ grade: ISOLATION_DISCIPLINARY, mode: "danger-full-access", copiesUnbound: true });
  assert.match(risky, /无写围栏/);
  const structural = isolationNote({ grade: ISOLATION_STRUCTURAL, mode: "workspace-write" });
  assert.match(structural, /隔离等级：结构/);
});

// ---------- pure: capability-graded next steps ----------

test("R17-C4 会话根路径按宿主能力分级；0.2.4 起会话内采用永远排第一（issue #5）", () => {
  assert.equal(sessionRootPath({ workspaceRegistry: true }), "gui-workspace");
  assert.equal(sessionRootPath({ workingDirectory: true }), "cwd-move");
  assert.equal(sessionRootPath({}), "unavailable");
  // issue #5: no human workspace ceremony first — adoption inside the session is
  // the first step on EVERY host; the structural upgrade is the optional second.
  const fallback = nextIsolationSteps({});
  assert.equal(fallback.length, 2);
  assert.match(fallback[0], /worktree_enter/);
  assert.match(fallback[0], /无需新开工作区/);
  assert.match(fallback[1], /真结构隔离（可选）/);
});

test("R17-C5 GUI 宿主：会话内采用仍排第一，宿主侧新开副本会话是可选升级", () => {
  const steps = nextIsolationSteps({ workspaceRegistry: true, workingDirectory: true });
  assert.match(steps[0], /worktree_enter/);
  assert.match(steps[1], /添加工作区/);
  // no GUI picker: the path-typed route is the only way to the optional upgrade
  const noPicker = withPathTypedRoute({ workspaceRegistry: true, directoryPicker: false, profilesDir: true });
  assert.equal(noPicker.length, 3);
  assert.match(noPicker[0], /dsh workspace/);
  assert.match(noPicker[0], /profile 目录存在/);
  assert.match(noPicker[1], /worktree_enter/);
});

test("R17-C6 fence 提示只说一次事实：写边界不含副本", () => {
  const line = fenceRecoveryLine({ workingDirectory: true });
  assert.match(line, new RegExp(FENCE_MARKER));
  assert.match(line, /worktree_enter/);
});

test("R17-C7 宿主探测只认实际存在的服务方法（缺能力 => 不给不可达路径）", async () => {
  const get = (key) => ({
    workspaceRegistry: { create() {} },
    workingDirectory: { set() {} },
    worktrees: { restore() {} },
  })[key];
  const caps = await probeHostCapabilities(get, { exists: async () => false });
  assert.equal(caps.workspaceRegistry, true);
  assert.equal(caps.workingDirectory, true);
  assert.equal(caps.worktreeService, true);
  assert.equal(caps.directoryPicker, false, "no picker service => no native folder dialog");
  // nothing at all (older host): every capability off, guidance falls back
  const none = await probeHostCapabilities(() => undefined, { exists: async () => false });
  assert.deepEqual(
    [none.workspaceRegistry, none.directoryPicker, none.workingDirectory, none.worktreeService],
    [false, false, false, false],
  );
  // issue #5: adoption itself needs no host capability — it is always offered,
  // and "no host says anything" only costs the optional structural upgrade.
  assert.match(nextIsolationSteps(none)[0], /worktree_enter/);
});

// ---------- deny path under a fenced sandbox ----------

const ctx = makeContext({
  mainRoot: MAIN,
  commonDir: COMMON,
  worktrees: [{ root: WT_A, name: "worktree-alpha" }, { root: WT_B, name: "worktree-beta" }],
});

test("R17-D1 跨副本写入的 next 不再许诺'绝对路径写副本'，而给出采用路径（issue #5）", () => {
  const d = decideWrite(`${WT_A}/src/a.ts`, MAIN, ctx, null, {});
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /worktree_enter/);
  assert.match(d.reason, /采用模式/);
  assert.doesNotMatch(d.reason, /以该副本为根新开会话后/);
});

test("R17-D2 写到会话够不着的副本：deny 追加 fence 行且不重复；写主 checkout 不加", async () => {
  const repo = await makeRepo();
  try {
    const mine = await lifecycle.create({ taskName: "r17 fence", cwd: repo });
    const other = await lifecycle.create({ taskName: "r17 other", cwd: repo });
    await lifecycle.enter({ path: mine.worktree, sessionId: "r17-fence", cwd: mine.worktree });
    let execN = 0;
    const mkExec = (file_path) => {
      execN += 1;
      return {
        name: "write",
        arguments: { file_path },
        callId: `r17-${execN}`,
        agent: { session: { header: { id: "r17-fence", cwd: mine.worktree, parentSession: null } } },
      };
    };
    const caps = { workspaceRegistry: true, directoryPicker: true, sandboxMode: "workspace-write" };
    const opts = { sandboxModeOf: () => "workspace-write", hostCapabilitiesOf: async () => caps };
    // the OTHER copy is outside this session's write boundary (root = my copy):
    // the fence line names the truth — an absolute-path retry would be refused.
    const d = await decideToolCall(mkExec(join(other.worktree, "x.ts")), opts);
    assert.equal(d.kind, "deny", d.reason);
    assert.match(d.reason, new RegExp(FENCE_MARKER));
    assert.equal(d.reason.split(FENCE_MARKER).length - 1, 1, "fence line appears exactly once");
    // a main-checkout deny is NOT a copy-reachability problem: no fence line
    const mainWrite = await decideToolCall(mkExec(join(repo, "src", "a.ts")), opts);
    assert.equal(mainWrite.kind, "deny", mainWrite.reason);
    assert.doesNotMatch(mainWrite.reason, new RegExp(FENCE_MARKER));
    // danger-full-access has no fence at all: nothing to add
    const noFence = await decideToolCall(mkExec(join(other.worktree, "y.ts")), { sandboxModeOf: () => "danger-full-access", hostCapabilitiesOf: async () => ({ sandboxMode: "danger-full-access" }) });
    assert.equal(noFence.kind, "deny", noFence.reason);
    assert.doesNotMatch(noFence.reason, new RegExp(FENCE_MARKER));
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------- integration: real repo ----------

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function makeRepo() {
  const d = await mkdtemp(join(tmpdir(), "wtg-r17-"));
  sh(d, "git", ["init", "-b", "main"]);
  sh(d, "git", ["config", "user.email", "t@t"]);
  sh(d, "git", ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "hello\n", "utf8");
  sh(d, "git", ["add", "."]);
  sh(d, "git", ["commit", "-m", "init", "-q"]);
  return d;
}
function mkExec(tool, args, cwd, sessionId) {
  return { name: tool, arguments: args, callId: `r17-${sessionId}-${Math.random()}`, agent: { session: { header: { id: sessionId, cwd, parentSession: null } } } };
}
function helpersFor(cwd, caps) {
  return {
    // session identity comes from exec (a hardcoded id silently mis-bound tests)
    sessionOf: (exec) => {
      const h = exec?.agent?.session?.header ?? {};
      return { id: h.id, cwd: h.cwd ?? cwd, parentSession: null };
    },
    config: async () => ({}),
    hostCapabilities: async () => caps,
    switchSession: async () => ({ ok: false, reason: "not wired in this test" }),
  };
}
const specOf = (specs, name) => specs.find((s) => s.name === name);

let repo;
before(async () => {
  repo = await makeRepo();
});
after(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

test("R17-I1 create 文案：宿主无 GUI 入口时不说'以副本为根新开会话'，并点名纪律级", async () => {
  const specs = toolSpecs(helpersFor(repo, { sandboxMode: "workspace-write" }));
  const create = specOf(specs, "worktree_create");
  const out = await create.execute({ task_name: "no gui", task_brief: "b" }, mkExec("worktree_create", {}, repo, "r17-s"));
  assert.ok(out.error === undefined, out.error);
  assert.equal(out.isolation, "disciplinary");
  const text = create.output.render({}, out)[0].text;
  assert.match(text, /隔离等级：纪律/);
  assert.doesNotMatch(text, /下一步（推荐）：以副本为根新开会话/);
  // issue #5: the first step is the in-session adoption, not a workspace ceremony
  assert.match(text, /worktree_enter/);
  assert.match(text, /无需新开工作区/);
});

test("R17-I2 enter：0.2.4 起会话内直接采用副本（issue #5），不再要求先切工作区", async () => {
  const specs = toolSpecs(helpersFor(repo, { workspaceRegistry: true, directoryPicker: true, sandboxMode: "workspace-write" }));
  const enter = specOf(specs, "worktree_enter");
  const created = await lifecycle.create({ taskName: "r17 alpha", cwd: repo });
  const adopted = await enter.execute({ path: created.worktree }, mkExec("worktree_enter", {}, repo, "r17-s"));
  assert.equal(adopted.bound, true);
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.mode, "adopted");
  assert.equal(adopted.isolation, "disciplinary");
  const text = enter.output.render({}, adopted)[0].text;
  assert.match(text, /采用模式/);
  assert.match(text, /cd <副本>/);
  // explicit host switch that the host refuses -> adoption still binds the work
  const switched = await enter.execute({ path: created.worktree, switch_session: true }, mkExec("worktree_enter", {}, repo, "r17-s2"));
  assert.equal(switched.bound, true);
  assert.equal(switched.adopted, true);
});

test("R17-I3 status 报告隔离等级 + 原因 + 可达动作", async () => {
  const specs = toolSpecs(helpersFor(repo, { workspaceRegistry: true, directoryPicker: true, workingDirectory: true, sandboxMode: "workspace-write" }));
  const status = specOf(specs, "worktree_status");
  const out = await status.execute({}, mkExec("worktree_status", {}, repo, "r17-status"));
  assert.equal(out.isolation, "disciplinary");
  assert.ok(out.isolation_reasons.includes("unbound-with-copies"));
  assert.ok(out.next_actions.length >= 1);
  // issue #5: the in-session route is listed first — no human workspace ceremony
  assert.match(out.next_actions[0], /worktree_enter/);
  assert.match(status.output.render({}, out)[0].text, /隔离：disciplinary/);
  // danger-full-access: the grade can never be structural (no fence at all)
  const risky = toolSpecs(helpersFor(repo, { sandboxMode: "danger-full-access" }));
  const out2 = await specOf(risky, "worktree_status").execute({}, mkExec("worktree_status", {}, repo, "r17-status"));
  assert.equal(out2.isolation, "disciplinary");
  assert.match(out2.isolation_note, /无写围栏/);
});

test("R17-I4 会话启动注入：存在未绑定副本时点名等级与可达路径（≤3 行）", async () => {
  const text = await sessionStartText({
    cwd: repo,
    sessionId: "r17-fresh",
    hostCaps: { workspaceRegistry: true, directoryPicker: true },
    sandboxMode: "workspace-write",
  });
  assert.ok(text);
  const lines = text.split("\n");
  assert.ok(lines.length <= 3, text);
  assert.match(text, /隔离等级：纪律/);
  assert.match(text, /worktree_enter/);
  // fenced sandbox + nested copy: the interim rule points at adoption, not at
  // the absolute-path write (that is the issue-#4 trap, now solved by adoption)
  assert.match(text, /采用副本/);
  assert.match(text, /\.worktrees\//);
  // danger-full-access: the usual absolute-path advice holds (no fence)
  const risky = await sessionStartText({ cwd: repo, sessionId: "r17-risky", hostCaps: {}, sandboxMode: "danger-full-access" });
  assert.ok(risky);
  assert.match(risky, /绝对路径/);
  assert.doesNotMatch(risky, new RegExp(FENCE_MARKER));
  // no copies at all -> no notice (zero injection, P1)
  const empty = await makeRepo();
  try {
    assert.equal(await sessionStartText({ cwd: empty, sessionId: "r17-empty", hostCaps: {}, sandboxMode: "workspace-write" }), null);
  } finally {
    await rm(empty, { recursive: true, force: true }).catch(() => {});
  }
});

test("R17-I5 宿主侧切换成功路径：绑定 + 本地切换，且不声称写边界已移动", async () => {
  const created = await lifecycle.create({ taskName: "r17 switch", cwd: repo });
  const moved = [];
  const helpers = {
    sessionOf: () => ({ id: "r17-move", cwd: repo }),
    config: async () => ({}),
    hostCapabilities: async () => ({ workspaceRegistry: true, sandboxMode: "workspace-write" }),
    switchSession: async (target) => {
      moved.push(target);
      return { ok: true, cwd: target, branch: "worktree-r17-switch", boundaryMoved: false };
    },
  };
  const enter = specOf(toolSpecs(helpers), "worktree_enter");
  const out = await enter.execute({ path: created.worktree, switch_session: true }, mkExec("worktree_enter", {}, repo, "r17-move"));
  assert.equal(out.bound, true);
  assert.equal(out.switched, true);
  assert.deepEqual(moved.length, 1);
  const text = enter.output.render({}, out)[0].text;
  assert.match(text, /已绑定/);
  assert.doesNotMatch(text, /结构性隔离/);
});
