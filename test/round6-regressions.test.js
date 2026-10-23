// Round-6 regressions: guard context carries commonDir (bare-layout state-area
// deny) and the sandbox probe tolerates async host resolve().
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideToolCall } from "../src/guard.js";
import * as lifecycle from "../src/core/lifecycle.js";

function sh(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const g = (cwd, args) => sh(cwd, args);
function mkExec({ tool, args, cwd, sessionId = "s1" }) {
  return { name: tool, arguments: args, callId: `c${Math.random()}`, agent: { session: { header: { id: sessionId, cwd } } } };
}

let bare, main;
test("R6-1 bare repo + worktree layout: state-area write denied (commonDir carried)", async () => {
  const d = await mkdtemp(join(tmpdir(), "wtg-r6-"));
  bare = d;
  // bare repo with a linked worktree: common dir is the bare .git-equivalent root
  sh(d, ["init", "--bare", "origin.git"]);
  sh(d, ["config", "--global", "--add", "safe.directory", "*"]);
  sh(d, ["config", "--global", "user.email", "t@t"]);
  sh(d, ["config", "--global", "user.name", "t"]);
  main = join(d, "main");
  sh(d, ["clone", "-q", join(d, "origin.git"), main]);
  sh(main, ["switch", "-c", "main", "-q"]); // initial branch (clone of empty)
  await writeFile(join(main, "a.txt"), "x");
  sh(main, ["add", "."]);
  sh(main, ["commit", "-m", "i", "-q"]);
  sh(main, ["push", "-q", "origin", "main"]);

  const wt = (await lifecycle.create({ taskName: "alpha", cwd: main, config: { baseRef: "main" } })).worktree;
  await lifecycle.enter({ path: wt, sessionId: "s1", cwd: wt });

  // state area lives under the BARE common dir — previously a dead rule
  const { commonDir } = await import("../src/core/gitops.js");
  const cd = await commonDir(wt);
  const w = await decideToolCall(mkExec({ tool: "write", args: { file_path: join(cd, "worktree-guard", "state.json") }, cwd: wt }), {});
  assert.equal(w.kind, "deny", "bare-layout state-area write must be denied");
});

test("R6-2 sandbox probe tolerates async host resolve()", async () => {
  const asyncOpts = {
    sandboxModeOf: async () => "danger-full-access",
  };
  const d = await mkdtemp(join(tmpdir(), "wtg-r6b-"));
  sh(d, ["init", "-b", "main"]);
  sh(d, ["config", "user.email", "t@t"]); sh(d, ["config", "user.name", "t"]);
  await writeFile(join(d, "a"), "x"); sh(d, ["add", "."]); sh(d, ["commit", "-m", "i", "-q"]);
  const wt = (await lifecycle.create({ taskName: "alpha", cwd: d })).worktree;
  await lifecycle.enter({ path: wt, sessionId: "s1", cwd: wt });
  const denied = await decideToolCall(mkExec({ tool: "write", args: { file_path: "b.txt" }, cwd: wt }), asyncOpts);
  assert.equal(denied.kind, "deny");
  assert.match(denied.reason, /danger-full-access/);
  await rm(d, { recursive: true, force: true }).catch(() => {});
});

after(async () => {
  if (bare) await rm(bare, { recursive: true, force: true }).catch(() => {});
});
