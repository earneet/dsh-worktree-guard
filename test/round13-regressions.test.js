// Round-13 regressions — GitHub issue #1 (live dogfood finding):
// (a) approvals-disabled sessions must not dead-end the ask gate;
// (b) the human-only CLI verb net must not deny read-only doc inspections,
//     WITHOUT reopening the self-authorization hole (fail-closed everywhere else);
// (c) every gate-directed deny names the runnable human CLI / manual fallback;
// (d) the CLI's human proof is a TYPED confirmation, not isTTY (a launched
//     child can get a real console TTY).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { decidePwsh, makeContext, isReadOnlyDocInspection } from "../src/core/decision.js";
import { decideToolCall, gateUnavailableReason, gateRejectionMark, isGatedTool, bustGuardContextCache } from "../src/guard.js";
import { confirmTyped } from "../src/core/human-gate.js";
import { authorizeMain, revokeMain, clampAuthorizeTtl } from "../src/core/authorize.js";
import { readState } from "../src/core/store.js";
import { CLI_PATH } from "../src/core/cli-path.js";
import { apply } from "../src/index.js";
import { toolSpecs } from "../src/wt-tools.js";
import { MAIN, WT_A, COMMON } from "./helpers/fixtures.js";

const contextText = (m) => m?.content?.[0]?.text ?? String(m);

const ctx = makeContext({ mainRoot: MAIN, commonDir: COMMON, worktrees: [{ root: WT_A, name: "worktree-alpha" }] });
const bound = { worktree: WT_A, branch: "worktree-alpha" };
const pw = (command, binding = null, auth = {}) => decidePwsh({ command, currentBranchName: "main" }, ctx, binding, auth);

// ---------- A. rule 0: fail-closed literal net + inspector-only hatch ----------

test("R13-A1 pure read-only doc inspection chains mentioning the verb -> allow", () => {
  for (const command of [
    `Get-Content README.md | Select-String -Pattern 'authorize-main'`,
    `git grep -n "authorize-main" README.md`,
    `rg "authorize-main" doc/`,
    `Select-String -Path README.md -Pattern authorize-main`,
    `Get-Content wt.js | Select-String authorize-main`,
    `git log --grep "authorize-main"`,
    `Get-ChildItem -Filter *authorize-main*`,
    `Select-String -Pattern 'author""ize-main' README.md`, // spliced verb as DATA in an inspector chain
    `Select-String -Pattern "node wt.js authorize-main" README.md`, // documented command as DATA
    `Get-Content README.md | Select-String -Pattern 'authorize-main' 2>&1`, // fd-dup redirect is not a file write
    `git log --grep "authorize-main" 2>&1`,
  ]) {
    assert.equal(pw(command).kind, "allow", `must allow read-only inspection: ${command}`);
    assert.equal(pw(command, bound).kind, "allow", `must allow bound too: ${command}`);
  }
});

test("R13-A2 literal verb stays fail-closed outside the hatch (launchers/languages/multiline)", () => {
  for (const command of [
    // direct invocations
    `node wt.js authorize-main "x" --ttl-minutes 240`,
    `node F:/tools/wt.js authorize_main --ttl-minutes 240`,
    `authorize-main "because" | node wt.js`,
    `./wt.js authorize-main`,
    `Rename-Item wt.js wg2.js; node wg2.js authorize-main "x"`,
    // launchers that can allocate a real console/TTY (the auditor's blocker class)
    `conhost node wt.js authorize-main`,
    `conhost.exe node wt.js authorize-main`,
    `winpty node wt.js authorize-main`,
    `python -c "import subprocess; subprocess.run(['node','wt.js','authorize-main'], creationflags=16)"`,
    `py -c "import subprocess; subprocess.run(['node','wt.js','authorize-main'], creationflags=16)"`,
    `nodejs node wt.js authorize-main`,
    `%ComSpec% /c node wt.js authorize-main`,
    `call node wt.js authorize-main`,
    `& { Start-Process node -ArgumentList 'wt.js','authorize-main' }`,
    // multiline mixing is NOT a read-only chain
    `npm test\ngit log --grep "authorize-main"`,
    `node --version\ngit commit -m "mention authorize-main"`,
    // writers / file redirection / inline-exec flags are NOT inspectors
    `Write-Host "see authorize-main in README"`,
    `Write-Output "wt authorize-main" > p.ps1`,
    `cat a.txt > b.txt authorize-main`,
    `git log --output=out.txt --grep authorize-main`,
    `git grep -Ocat authorize-main`,
    `git grep -nOcat authorize-main`,
    `git grep -iOcat authorize-main`,
    `git grep -O ./pager authorize-main`,
    `git grep --open-files-in-pager=cat authorize-main`,
    `rg --pre ./hook.sh "authorize-main"`,
    `git commit -m "docs: explain authorize-main"`,
    `Get-Content x | ForEach-Object { node wt.js authorize-main }`,
  ]) {
    const d = pw(command);
    assert.equal(d.kind, "deny", `must deny literal mention: ${command}`);
    assert.match(d.reason, /自授|人工通道/);
  }
});

test("R13-A3 wrapper/splice forms are still netted via the normalized view", () => {
  for (const command of [
    `cmd /c "node wt.js authorize-main"`,
    `cmd /c start "" node wt.js authorize-main`,
    `Start-ThreadJob { node wt.js authorize-main }`,
    `wmic process call create "node wt.js authorize-main"`,
    `pwsh -Command "wt authorize-main"`,
    `iex 'wt authorize-main'`,
    `bash -c "wt authorize-main"`,
    `Start-Process node -ArgumentList 'wt.js','authorize-main'`,
    `node wt.js author""ize-main`,
    `cmd /c "node wt.js author""ize-main"`, // splice + wrapper: raw misses, normalized catches
    `pwsh -Command "node wt.js author""ize-main"`,
    `Select-String -Pattern x; node wt.js authorize-main`,
  ]) {
    assert.equal(pw(command).kind, "deny", `must deny wrapped/spliced invocation: ${command}`);
  }
});

test("R13-A4 isReadOnlyDocInspection is the narrow hatch (unit)", () => {
  assert.equal(isReadOnlyDocInspection(`Get-Content a | Select-String authorize-main`), true);
  assert.equal(isReadOnlyDocInspection(`git grep -n authorize-main`), true);
  assert.equal(isReadOnlyDocInspection(`Get-Content a; node wt.js authorize-main`), false);
  assert.equal(isReadOnlyDocInspection(`Get-Content a | ForEach-Object { authorize-main }`), false);
  assert.equal(isReadOnlyDocInspection(`$(authorize-main)`), false);
  assert.equal(isReadOnlyDocInspection(`Get-Content (authorize-main)`), false);
  assert.equal(isReadOnlyDocInspection(`rg --pre ./hook.sh authorize-main`), false);
  assert.equal(isReadOnlyDocInspection(`git grep -Ocat authorize-main`), false);
  assert.equal(isReadOnlyDocInspection(`git grep -nOcat authorize-main`), false);
  assert.equal(isReadOnlyDocInspection(`Write-Output x`), false);
  assert.equal(isReadOnlyDocInspection(`Get-Content a > b`), false);
  assert.equal(isReadOnlyDocInspection(`git log --output=x --grep authorize-main`), false);
  assert.equal(isReadOnlyDocInspection(`rg -n authorize-main doc/`), true);
  assert.equal(isReadOnlyDocInspection(`Get-Content a | Select-String x 2>&1`), true);
  assert.equal(isReadOnlyDocInspection(`Select-String -Pattern "node wt.js authorize-main" README.md`), true);
});

test("R13-A5 rule-0 deny keeps the three-part copy and names the runnable CLI", async () => {
  const d = pw(`node wt.js authorize-main "x"`);
  assert.equal(d.kind, "deny");
  assert.equal(d.reason.split("\n").length, 3);
  assert.match(d.reason, /自授|人工通道/);
  assert.ok(d.reason.includes(CLI_PATH), "deny copy must embed the resolved CLI path");
  assert.match(d.reason, /authorize-main/);
  // the embedded path must be the REAL shipped entry point (regression: a wrong
  // relative depth pointed at <pkg>/src/wt.js, which does not exist)
  const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
  assert.equal(CLI_PATH, join(PKG_ROOT, "wt.js"));
  assert.match(basename(CLI_PATH), /^wt\.(?:m?js)$/);
  await access(CLI_PATH); // throws if the path is not a real file
});

// ---------- B. approvals-disabled gate: deny instead of doomed ask ----------

const gatedExec = (name = "worktree_authorize_main") => ({
  name,
  arguments: { reason: "x" },
  callId: "g1",
  agent: { session: { header: { id: "s1" } } },
});

test("R13-B1 policy never -> immediate deny with human fallback (no doomed ask)", async () => {
  const d = await decideToolCall(gatedExec(), { approvalPolicyOf: async () => "never" });
  assert.equal(d.kind, "deny");
  const lines = d.reason.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\[worktree-guard\] 已阻止 worktree_authorize_main/);
  assert.match(d.reason, /审批提示被禁用|approval=never/);
  assert.ok(d.reason.includes(CLI_PATH));
  assert.match(d.reason, /确认码/);
});

test("R13-B2 policy ask/unknown/probe-failure keeps the ask path", async () => {
  assert.equal((await decideToolCall(gatedExec(), { approvalPolicyOf: async () => "ask" })).kind, "ask");
  assert.equal((await decideToolCall(gatedExec(), {})).kind, "ask");
  assert.equal((await decideToolCall(gatedExec(), { approvalPolicyOf: async () => { throw new Error("x"); } })).kind, "ask");
});

test("R13-B3 worktree_allow under never points at preset/whitelist, not the authorize CLI", async () => {
  const d = await decideToolCall(gatedExec("worktree_allow"), { approvalPolicyOf: async () => "never" });
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /main_write_whitelist/);
  assert.doesNotMatch(d.reason, /authorize-main/);
});

// ---------- C. plugin wiring: policy probe + post-execute marker ----------

function mockCtx({ approval } = {}) {
  const handlers = {};
  const registered = [];
  return {
    on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
    tools: { define: (s) => s, register: (d) => registered.push(d) },
    fs: {},
    get: (n) => (n === "approval" ? approval : undefined),
    _handlers: handlers,
    _registered: registered,
    async fire(ev, ...args) {
      let last;
      const next = (v) => { last = v ?? { kind: "accept" }; return last; };
      for (const fn of handlers[ev] ?? []) last = await fn(...args, next);
      return last;
    },
  };
}
const sessionHeader = { id: "e1", cwd: MAIN };
const execOf = (name) => ({ name, arguments: { reason: "x" }, callId: `c-${name}`, agent: { session: { header: sessionHeader } } });

test("R13-C1 apply(): session override never -> deny；override ask + config never -> ask", async () => {
  const neverOverride = mockCtx({ approval: { overrideOf: () => "never", config: { policy: "ask" } } });
  apply(neverOverride, {});
  const denied = await neverOverride.fire("tools/pre-execute", execOf("worktree_authorize_main"));
  assert.equal(denied.kind, "deny");
  assert.match(denied.reason, /审批提示被禁用/);

  const askOverride = mockCtx({ approval: { overrideOf: () => "ask", config: { policy: "never" } } });
  apply(askOverride, {});
  assert.equal((await askOverride.fire("tools/pre-execute", execOf("worktree_authorize_main"))).kind, "ask");
});

test("R13-C2 apply(): config default never (no override) -> deny; absent service -> ask", async () => {
  const cfgNever = mockCtx({ approval: { overrideOf: () => undefined, config: { policy: "never" } } });
  apply(cfgNever, {});
  assert.equal((await cfgNever.fire("tools/pre-execute", execOf("worktree_authorize_main"))).kind, "deny");

  const noService = mockCtx();
  apply(noService, {});
  assert.equal((await noService.fire("tools/pre-execute", execOf("worktree_authorize_main"))).kind, "ask");
});

test("R13-C3 live-Session shape: overrideOf folds the last approval/policy event", async () => {
  // dsh Session contract: { header, seq, eventAt(seq) } — the real overrideOf
  // walks the log backwards. Guards the host-shape assumption with a fake Session.
  const session = {
    header: { id: "e1", cwd: MAIN },
    seq: 3,
    eventAt(n) {
      if (n === 2) return null;
      if (n === 1) return { type: "approval/policy", data: { policy: "never" } };
      return null;
    },
  };
  const approval = {
    overrideOf(s) {
      for (let i = s.seq - 1; i >= 0; i--) {
        const e = s.eventAt(i);
        if (e?.type === "approval/policy") return e.data.policy;
      }
      return undefined;
    },
    config: { policy: "ask" },
  };
  const c = mockCtx({ approval });
  apply(c, {});
  const exec = { name: "worktree_authorize_main", arguments: { reason: "x" }, callId: "live", agent: { session } };
  assert.equal((await c.fire("tools/pre-execute", exec)).kind, "deny");
});

test("R13-C4 post-execute: rejection advisory follows the re-probed policy and the tool", async () => {
  const failure = { isError: true, error: { message: 'the user rejected tool "worktree_authorize_main"' }, content: [{ type: "text", text: 'Error: the user rejected tool "worktree_authorize_main"' }] };

  const neverCtx = mockCtx({ approval: { overrideOf: () => "never", config: { policy: "ask" } } });
  apply(neverCtx, {});
  const exec = execOf("worktree_authorize_main");
  const out = await neverCtx.fire("tools/post-execute", exec, failure, async () => ({ kind: "accept" }));
  const extra = out.additionalContexts ?? [];
  assert.ok(extra.some((m) => /approval=never/.test(contextText(m)) && /确认码/.test(contextText(m))), "never marker expected");
  // host contract: additionalContexts is UserMessage[], not bare strings
  assert.equal(extra.at(-1)?.role, "user");
  assert.equal(extra.at(-1)?.source?.kind, "user");
  assert.equal(typeof extra.at(-1)?.id, "string");

  // policy ask/unknown: neutral wording, no false "approval prompts disabled" claim
  const askCtx = mockCtx({ approval: { overrideOf: () => "ask", config: { policy: "ask" } } });
  apply(askCtx, {});
  const out2 = await askCtx.fire("tools/post-execute", execOf("worktree_authorize_main"), failure, async () => ({ kind: "accept" }));
  const mark2 = contextText((out2.additionalContexts ?? []).at(-1));
  assert.doesNotMatch(mark2, /approval=never/);
  assert.match(mark2, /未必|可能/);

  // worktree_allow never-marker: no authorize-main CLI pointer
  assert.doesNotMatch(String(gateRejectionMark(execOf("worktree_allow"), failure, "never")), /authorize-main/);
  // non-gated / non-error: no marker
  assert.equal(gateRejectionMark({ name: "write" }, failure, "never"), null);
  assert.equal(gateRejectionMark(exec, { isError: false }, "never"), null);
  assert.equal(isGatedTool("worktree_allow"), true);
  assert.equal(isGatedTool("write"), false);
});

test("R13-C5 post-execute probes the approval policy ONLY for gated tools", async () => {
  let calls = 0;
  const approval = { overrideOf: () => { calls++; return "never"; }, config: { policy: "ask" } };
  const c = mockCtx({ approval });
  apply(c, {});
  const failure = { isError: true, error: { message: "boom" }, content: [] };
  await c.fire("tools/post-execute", execOf("write"), failure, async () => ({ kind: "accept" }));
  assert.equal(calls, 0);
  await c.fire("tools/post-execute", execOf("worktree_allow"), { isError: true, error: { message: 'the user rejected tool "x"' }, content: [] }, async () => ({ kind: "accept" }));
  assert.equal(calls, 1);
});

// ---------- D. CLI typed human proof ----------

test("R13-D1 confirmTyped: exact phrase (case-insensitive) only", async () => {
  const mk = () => ({ input: new PassThrough(), output: new PassThrough(), phrase: "K7Q2" });
  const a = mk();
  const pa = confirmTyped({ ...a, timeoutMs: 1000 });
  a.input.write("k7q2\n"); // case-insensitive
  assert.equal(await pa, true);

  const b = mk();
  const pb = confirmTyped({ ...b, timeoutMs: 1000 });
  b.input.write("no\n");
  assert.equal(await pb, false);

  const c = mk();
  const pc = confirmTyped({ ...c, timeoutMs: 1000 });
  c.input.write("K7Q2 please\n"); // not an exact confirmation
  assert.equal(await pc, false);
});

test("R13-D2 confirmTyped: silence (launched console, no human) times out false", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const started = Date.now();
  assert.equal(await confirmTyped({ input, output, phrase: "K7Q2", timeoutMs: 30 }), false);
  assert.ok(Date.now() - started < 2000);
  // no phrase => fail closed (a fixed/empty default must never confirm)
  assert.equal(await confirmTyped({ input: new PassThrough(), output: new PassThrough(), timeoutMs: 30 }), false);
});

test("R13-D2b confirmTyped: an errored stdin fails closed instead of crashing", async () => {
  const input = new PassThrough();
  const p = confirmTyped({ input, output: new PassThrough(), phrase: "K7Q2", timeoutMs: 1000 });
  input.destroy(new Error("stream boom"));
  assert.equal(await p, false);
});

test("R13-D3 authorizeMain: the single grant path writes state ONLY after confirm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wtg-auth-"));
  try {
    const denied = await authorizeMain({ commonDir: dir, reason: "t", ttlMinutes: 5, confirm: async () => false });
    assert.equal(denied.authorized, false);
    assert.equal((await readState(dir)).allow_main_writes?.allow_main_writes, undefined, "no grant before confirmation");
    await assert.rejects(access(join(dir, "worktree-guard", "audit.jsonl")), "no audit entry without a confirmation");
    const ok = await authorizeMain({ commonDir: dir, reason: "t", ttlMinutes: 5, by: "user-ask-gate", session: "s1", confirm: async () => true });
    assert.equal(ok.authorized, true);
    const st = (await readState(dir)).allow_main_writes;
    assert.equal(st.allow_main_writes, true);
    assert.equal(st.allow_by, "user-ask-gate");
    assert.equal(st.allow_reason, "t");
    assert.ok(Date.parse(st.allow_expires_at) > Date.now());
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("R13-D4 authorizeMain clamps TTL into 1..240 and defaults falsy to 15", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wtg-auth-"));
  try {
    assert.equal(clampAuthorizeTtl(0), 15);
    assert.equal(clampAuthorizeTtl(""), 15);
    assert.equal(clampAuthorizeTtl(99999), 240);
    assert.equal((await authorizeMain({ commonDir: dir, ttlMinutes: 0, confirm: async () => true })).ttlMinutes, 15);
    assert.equal((await authorizeMain({ commonDir: dir, ttlMinutes: 99999, confirm: async () => true })).ttlMinutes, 240);
    assert.equal((await authorizeMain({ commonDir: dir, ttlMinutes: -5, confirm: async () => true })).ttlMinutes, 1);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("R13-D5 revokeMain: the same single path clears the grant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wtg-auth-"));
  try {
    await authorizeMain({ commonDir: dir, reason: "t", ttlMinutes: 5, confirm: async () => true });
    assert.equal((await readState(dir)).allow_main_writes.allow_main_writes, true);
    await revokeMain({ commonDir: dir, by: "cli-human" });
    assert.equal((await readState(dir)).allow_main_writes?.allow_main_writes, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------- E. copy surface: deny texts + tool descriptions ----------

test("R13-E1 push deny (explicit/implicit/wrapped) names the human fallback", () => {
  for (const command of ["git push origin main", "git push", 'cmd /c "git push origin main"']) {
    const d = pw(command, null);
    assert.equal(d.kind, "deny", command);
    assert.equal(d.reason.split("\n").length, 3, command);
    assert.match(d.reason, /worktree_authorize_main/, command);
    assert.match(d.reason, /审批提示被禁用|审批被禁用|授权工具/, command);
    assert.match(d.reason, /手动推送|手动/, command);
  }
});

test("R13-E2 tool descriptions advertise the runnable fallback and typed confirmation", () => {
  const specs = toolSpecs({ sessionOf: () => ({}), config: async () => ({}) });
  const get = (n) => specs.find((s) => s.name === n);
  for (const name of ["worktree_authorize_main", "worktree_allow"]) {
    const desc = get(name).description;
    assert.match(desc, /user rejected tool/i, name);
    assert.match(desc, /policy never|approval/i, name);
  }
  const authDesc = get("worktree_authorize_main").description;
  assert.ok(authDesc.includes(CLI_PATH), "authorize description must embed the resolved CLI path");
  assert.match(authDesc, /confirmation code/i);
});

test("R13-E3 gateUnavailableReason is three-part for both gated tools", () => {
  for (const name of ["worktree_authorize_main", "worktree_allow"]) {
    const d = gateUnavailableReason(name);
    assert.equal(d.kind, "deny");
    const lines = d.reason.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[2], /^下一步：/);
  }
});

test("R13-E4 copy budgets: every deny 3 lines, markers 1 line, descriptions <=120 words", () => {
  const lines = (s) => String(s).split("\n").length;
  const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
  for (const d of [
    pw("git push origin main"),
    pw("node wt.js authorize-main x"),
    gateUnavailableReason("worktree_authorize_main"),
    gateUnavailableReason("worktree_allow"),
  ]) {
    assert.equal(d.kind, "deny");
    assert.equal(lines(d.reason), 3);
  }
  const marker = gateRejectionMark(execOf("worktree_authorize_main"), { isError: true, error: { message: 'the user rejected tool "x"' } }, "never");
  assert.equal(lines(marker), 1);
  const specs = toolSpecs({ sessionOf: () => ({}), config: async () => ({}) });
  for (const name of ["worktree_authorize_main", "worktree_allow"]) {
    assert.ok(words(specs.find((s) => s.name === name).description) <= 120, `${name} description word budget`);
  }
});

// ---------- F. self-authorization surfaces found by the round-13 audit ----------

test("R13-F1 bare state-dir cd + relative write is denied (pre-existing hole)", () => {
  for (const command of [
    `cd .git/worktree-guard\nSet-Content state.json '{}'`,
    `cd .git/worktree-guard`,
    `Get-Content .git/worktree-guard/audit.jsonl`,
  ]) {
    assert.equal(pw(command).kind, "deny", `state area must be unreachable: ${command}`);
  }
});

test("R13-F3 plugin Config cannot drop the default protected branches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wtg-cfg-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    await writeFile(join(dir, "a.txt"), "x");
    git("add", ".");
    git("commit", "-m", "i", "-q");
    bustGuardContextCache();
    const mkExec = (command) => ({ name: "pwsh", arguments: { command }, callId: `f3-${command}`, agent: { session: { header: { id: "s1", cwd: dir } } } });
    const opts = { protectedBranches: ["pluginExtra"] };
    assert.equal((await decideToolCall(mkExec("git push origin main"), opts)).kind, "deny", "default main must stay protected with a custom plugin Config");
    assert.equal((await decideToolCall(mkExec("git push origin pluginExtra"), opts)).kind, "deny", "configured extra branch must be protected too");
    assert.equal((await decideToolCall(mkExec("git push origin feature-x"), opts)).kind, "allow", "unprotected branches stay pushable");
  } finally {
    bustGuardContextCache();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("R13-F2 sidecar cannot weaken protection and the model cannot write it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wtg-sidecar-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    await writeFile(join(dir, "a.txt"), "x");
    git("add", ".");
    git("commit", "-m", "i", "-q");
    await mkdir(join(dir, ".dsh"), { recursive: true });
    await writeFile(join(dir, ".dsh", "worktree-guard.json"), JSON.stringify({ protected_branches: ["zzz"] }));
    bustGuardContextCache();
    const mkExec = (tool, args) => ({ name: tool, arguments: args, callId: `f2-${tool}`, agent: { session: { header: { id: "s1", cwd: dir } } } });
    const push = await decideToolCall(mkExec("pwsh", { command: "git push origin main" }), {});
    assert.equal(push.kind, "deny", "sidecar must not remove master/main from the protected set");
    const w = await decideToolCall(mkExec("write", { file_path: join(dir, ".dsh", "worktree-guard.json") }), {});
    assert.equal(w.kind, "deny", "model must not be able to write the security config");
  } finally {
    bustGuardContextCache();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
