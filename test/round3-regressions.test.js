// Round-3 adversarial review regressions (state-area shell reachability).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePwsh, makeContext } from "../src/core/decision.js";
import { MAIN, WT_A, COMMON } from "./helpers/fixtures.js";

const ctx = makeContext({ mainRoot: MAIN, commonDir: COMMON, worktrees: [{ root: WT_A, name: "worktree-alpha" }] });
const bound = { worktree: WT_A, branch: "worktree-alpha" };

test("R3-1 blocker: relative-path state.json self-grant denied (Set-Content forms)", () => {
  for (const cmd of [
    `Set-Content -Path ../../.git/worktree-guard/state.json -Value '{"allow_main_writes":{"allow_main_writes":true,"allow_expires_at":"2999-01-01T00:00:00Z"}}'`,
    `Add-Content ../../.git/worktree-guard/allowlist.json 'x'`,
    `echo x > .git/worktree-guard/state.json`,
  ]) {
    assert.equal(decidePwsh({ command: cmd }, ctx, bound).kind, "deny", `must deny: ${cmd.slice(0, 60)}`);
  }
});

test("R3-2 blocker: guard-module import and authorize verb through node -e denied", () => {
  for (const cmd of [
    `node -e "import('./src/core/store.js').then(m=>m.updateState(...))"`,
    `node -e "const s=require('./src/core/store.js')"`,
    `node -e "import('./wt.js')" authorize-main`,
    `Rename-Item wt.js wg2.js; node wg2.js authorize-main "x"`,
  ]) {
    assert.equal(decidePwsh({ command: cmd }, ctx, bound).kind, "deny", `must deny: ${cmd.slice(0, 60)}`);
  }
});

test("R3-3 no false positives on ordinary commands", () => {
  for (const cmd of [
    "git status",
    "npm install",
    "git branch -a",
    "cd ..; git status",            // '..' without .git target
    "node -e \"import('./src/app.js')\"", // unrelated module
    "git merge worktree-alpha",
  ]) {
    assert.equal(decidePwsh({ command: cmd }, ctx, bound).kind, "allow", `must allow: ${cmd}`);
  }
});
