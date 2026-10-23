// Round-5 review regressions: sidecar wiring (B1), C9 sandbox net, B2 channel-3
// parentSession, stale-hint threshold, tool error contract (m1).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideToolCall } from "../src/guard.js";
import { toolSpecs } from "../src/wt-tools.js";
import { sessionStartText } from "../src/notices.js";
import { loadSidecar, normalizeSidecar, globMatch } from "../src/core/sidecar.js";
import * as lifecycle from "../src/core/lifecycle.js";
import { norm } from "../src/core/paths.js";

function sh(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function mkExec({ tool, args, cwd, sessionId = "s1", parentSession = null }) {
  return { name: tool, arguments: args, callId: `c${Math.random()}`, agent: { session: { header: { id: sessionId, cwd, parentSession } } } };
}

let repo, wt;
before(async () => {
  repo = await mkdtemp(join(tmpdir(), "wtg-r5-"));
  sh(repo, ["init", "-b", "main"]);
  sh(repo, ["config", "user.email", "t@t"]); sh(repo, ["config", "user.name", "t"]);
  await writeFile(join(repo, "a.txt"), "x"); sh(repo, ["add", "."]); sh(repo, ["commit", "-m", "i", "-q"]);
  wt = (await lifecycle.create({ taskName: "alpha", cwd: repo })).worktree;
  await lifecycle.enter({ path: wt, sessionId: "s1", cwd: wt });
});
after(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

test("R5-1a sidecar snake_case keys normalize to camelCase", () => {
  const n = normalizeSidecar({ branch_prefix: "task-", protected_branches: ["trunk"], read_policy: "strict", sync: { copy_files: [".env"] } });
  assert.equal(n.branchPrefix, "task-");
  assert.deepEqual(n.protectedBranches, ["trunk"]);
  assert.equal(n.readPolicy, "strict");
  assert.deepEqual(n.sync.copyFiles, [".env"]);
});

test("R5-1b sidecar read_policy reaches the guard (strict via sidecar)", async () => {
  await mkdir(join(repo, ".dsh"), { recursive: true });
  await writeFile(join(repo, ".dsh", "worktree-guard.json"), JSON.stringify({ read_policy: "strict" }), "utf8");
  const d = await decideToolCall(mkExec({ tool: "read", args: { file_path: join(repo, "a.txt") }, cwd: wt }), { readPolicy: "warn" });
  assert.equal(d.kind, "deny", "sidecar strict must override plugin warn");
  await rm(join(repo, ".dsh", "worktree-guard.json"), { force: true });
});

test("R5-1c sidecar protected_branches reaches the net", async () => {
  await mkdir(join(repo, ".dsh"), { recursive: true });
  await writeFile(join(repo, ".dsh", "worktree-guard.json"), JSON.stringify({ protected_branches: ["trunk"] }), "utf8");
  const denyCase = await decideToolCall(mkExec({ tool: "pwsh", args: { command: "git push origin trunk" }, cwd: wt }), {});
  assert.equal(denyCase.kind, "deny", "sidecar-declared protected branch must be netted");
  const okCase = await decideToolCall(mkExec({ tool: "pwsh", args: { command: "git push origin main" }, cwd: wt }), {});
  assert.equal(okCase.kind, "allow", "default main is no longer protected when sidecar overrides");
  await rm(join(repo, ".dsh", "worktree-guard.json"), { force: true });
});

test("R5-1d sidecar main_write_whitelist lifts main writes", async () => {
  await mkdir(join(repo, "generated"), { recursive: true });
  await mkdir(join(repo, ".dsh"), { recursive: true });
  await writeFile(join(repo, ".dsh", "worktree-guard.json"), JSON.stringify({ main_write_whitelist: ["generated/*"] }), "utf8");
  const ok = await decideToolCall(mkExec({ tool: "write", args: { file_path: join(repo, "generated", "out.ts") }, cwd: wt }), {});
  assert.equal(ok.kind, "allow", "whitelisted subtree write must pass");
  const no = await decideToolCall(mkExec({ tool: "write", args: { file_path: join(repo, "src", "a.ts") }, cwd: wt }), {});
  assert.equal(no.kind, "deny", "non-whitelisted main write stays denied");
  await rm(join(repo, ".dsh", "worktree-guard.json"), { force: true });
});

test("R5-1e glob helper semantics", () => {
  assert.ok(globMatch("generated/*", "F:/x/repo/generated/out.ts") === globMatch("generated/*", norm("F:/x/repo/generated/out.ts")));
});

test("R5-2 C9: bound + danger-full-access denies non-lifecycle tools; worktree_* exempt (P5)", async () => {
  const opts = { sandboxModeOf: () => "danger-full-access" };
  const denied = await decideToolCall(mkExec({ tool: "write", args: { file_path: "b.txt" }, cwd: wt }), opts);
  assert.equal(denied.kind, "deny");
  assert.match(denied.reason, /danger-full-access/);
  const exempt = await decideToolCall(mkExec({ tool: "worktree_status", args: {}, cwd: wt }), opts);
  assert.notEqual(exempt.kind, "deny");
  // capability absent -> no-op (P1)
  const absent = await decideToolCall(mkExec({ tool: "write", args: { file_path: "b.txt" }, cwd: wt }), {});
  assert.equal(absent.kind, "allow");
});

test("R5-3 channel 3 honors parentSession (inherited rooted session gets guidance)", async () => {
  const child = await sessionStartText({ cwd: wt, sessionId: "sub-1", parentSession: "s1" });
  assert.match(child, /本副本/);
});

test("R5-4 stale hint is silent right after create (fresh last_active)", async () => {
  const t = await sessionStartText({ cwd: repo, sessionId: "fresh" });
  assert.equal(t, null);
});

test("R5-5 m1: tool errors keep the three-part contract (structured { error } + render)", async () => {
  const specs = toolSpecs({ sessionOf: () => ({ id: "s1", cwd: repo }), config: async () => ({}) });
  const enter = specs.find((s) => s.name === "worktree_enter");
  const out = await enter.execute({ path: "no-such-worktree" }, {});
  // round-10 defineTool contract: execute returns a structured value; the
  // three-part text lives in { error } (throw path) or the refusal render.
  const text = enter.output.render({}, out)[0].text;
  assert.match(text, /^\[worktree-guard\]/);
  assert.match(text, /原因：/);
  assert.match(text, /下一步：/);
});
