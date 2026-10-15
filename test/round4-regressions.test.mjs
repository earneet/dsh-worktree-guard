// Round-4 polish regressions: guard-module rule precision + CLI TTY gate.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePwsh, makeContext } from "../src/core/decision.mjs";
import { fileURLToPath } from "node:url";
import { MAIN, WT_A, COMMON } from "./helpers/fixtures.mjs";

const ctx = makeContext({ mainRoot: MAIN, commonDir: COMMON, worktrees: [{ root: WT_A, name: "a" }] });
const bound = { worktree: WT_A, branch: "worktree-alpha" };

test("R4-1 guard-module rule: precise context, no user-file false positives", () => {
  // OUR modules (src/ or worktree-guard/ context, or the CLI entry) -> deny
  for (const cmd of [
    `node -e "import('./src/core/store.mjs').then(m=>m.updateState(1))"`,
    `node -e "import('./worktree-guard/src/core/lifecycle.mjs')"`,
    `node -e "import('./wt.mjs')"`,
    `node -e "const g=require('./src/guard.mjs')"`,
  ]) {
    assert.equal(decidePwsh({ command: cmd }, ctx, bound).kind, "deny", `must deny: ${cmd}`);
  }
  // user-owned same-name modules without our context -> allow (round-4 fix)
  for (const cmd of [
    `node -e "import('./store.mjs')"`,
    `node -e "import('./guard.mjs')"`,
    `node -e "import('./lifecycle.mjs')"`,
  ]) {
    assert.equal(decidePwsh({ command: cmd }, ctx, bound).kind, "allow", `must allow: ${cmd}`);
  }
});

let repo;
test("R4-2 CLI authorize-main refuses non-TTY (model shells) structurally", async () => {
  const d = await mkdtemp(join(tmpdir(), "wtg-r4-"));
  repo = d;
  const sh = (args) => execFileSync("git", args, { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  sh(["init", "-b", "main"]);
  sh(["config", "user.email", "t@t"]); sh(["config", "user.name", "t"]);
  await writeFile(join(d, "a"), "x"); sh(["add", "."]); sh(["commit", "-m", "i", "-q"]);
  const cli = fileURLToPath(new URL("../wt.mjs", import.meta.url));
  let failed = false;
  try {
    // execFileSync pipes stdout/stderr -> stdin is not a TTY
    execFileSync("node", [cli, "authorize-main", "test", "--ttl-minutes", "240"], { cwd: d, encoding: "utf8" });
  } catch {
    failed = true;
  }
  assert.ok(failed, "non-TTY authorize-main must exit non-zero");
  const { readState } = await import("../src/core/store.mjs");
  const { commonDir } = await import("../src/core/gitops.mjs");
  const st = await readState(await commonDir(d));
  assert.equal(st.allow_main_writes?.allow_main_writes, undefined, "no grant may be written via non-TTY CLI");
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true }).catch(() => {});
});
