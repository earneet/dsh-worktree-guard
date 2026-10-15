// round-11 regression: tool wire projections must be LOSSLESS JSON — the host
// snapshots request/header (tools included) and rejects undefined-valued keys
// ("non-JSON-serializable data"). Root cause was a (name, desc) helper called
// with one argument, leaving `description: undefined` in boolean parameters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolSpecs } from "../src/wt-tools.mjs";

function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEq(a[k], b[k]));
}
function lossless(x) {
  try { return JSON.stringify(x) !== undefined && deepEq(JSON.parse(JSON.stringify(x)), x); }
  catch { return false; }
}
// mirrors dsh-tools schemaOf(): {name, description, parameters} per tool
function noUndefinedKeys(o, path = "") {
  for (const [k, v] of Object.entries(o)) {
    assert.notEqual(v, undefined, `undefined value at ${path}.${k}`);
    if (v && typeof v === "object") noUndefinedKeys(v, `${path}.${k}`);
  }
}

test("R11-1 every tool wire projection {name,description,parameters} is lossless JSON", () => {
  const checkReq = (node, path) => {
    if (node && typeof node === "object") {
      if (node.type !== "object" && "required" in node && Array.isArray(node.required) === false) {
        throw new Error(`inline required on ${node.type} at ${path} (strict provider APIs reject it: GLM 400/1210)`);
      }
      for (const [k, v] of Object.entries(node)) if (v && typeof v === "object") checkReq(v, `${path}.${k}`);
    }
  };
  for (const s of toolSpecs({})) {
    noUndefinedKeys(s.parameters, `${s.name}.parameters`);
    checkReq(s.parameters, `${s.name}.parameters`);
    const proj = { name: s.name, description: s.description, parameters: structuredClone(s.parameters) };
    assert.ok(lossless(proj), `${s.name} must survive JSON round-trip losslessly`);
    assert.equal(typeof s.name, "string");
    assert.equal(typeof s.description, "string");
  }
});

test("R11-2 every tool declares output {schema, render} (defineTool contract)", () => {
  for (const s of toolSpecs({})) {
    assert.ok(s.output && typeof s.output === "object", `${s.name} missing output`);
    assert.equal(typeof s.output.render, "function", `${s.name} output.render`);
    assert.ok(lossless(s.output.schema), `${s.name} output.schema must be lossless JSON`);
    // required only on parent objects (strict JSON-subset rule)
    const checkReq = (node, path) => {
      if (node && typeof node === "object") {
        if (node.type !== "object" && "required" in node && Array.isArray(node.required) === false) {
          throw new Error(`inline required on ${node.type} at ${path}`);
        }
        for (const [k, v] of Object.entries(node)) if (v && typeof v === "object") checkReq(v, `${path}.${k}`);
      }
    };
    checkReq(s.output.schema, `${s.name}.output.schema`);
  }
});

// round-12 dogfood finding: working INSIDE the plugin's own repo must not trip
// the state-area shell net — the old bare "worktree-guard/" pattern matched
// F:\...\dsh-worktree-guard\package.json and denied all development commands.
import { decidePwsh } from "../src/core/decision.mjs";
import { P } from "./helpers/fixtures.mjs";
const CTX12 = {
  mainRoot: P("C:/repo"), commonDir: P("C:/repo/.git"),
  worktrees: [{ root: P("C:/repo/.worktrees/worktree-x"), name: "worktree-x" }],
  protectedBranches: ["master", "main"], branchPrefix: "worktree-",
};
test("R12-1 state-area net requires .git context; plugin's own repo path is allowed", () => {
  // own-repo paths (no .git/worktree-guard segment) -> allow
  for (const cmd of [
    `Get-Content F:\\workspace_2\\dsh-worktree-guard\\package.json`,
    `node F:/workspace_2/dsh-worktree-guard/wt.mjs status`,
    `npm --prefix dsh-worktree-guard test`,
  ]) {
    assert.equal(decidePwsh({ command: cmd }, CTX12, null).kind, "allow", `must allow: ${cmd}`);
  }
  // real state-area reachability stays denied (absolute and relative forms)
  for (const cmd of [
    `Set-Content C:\\repo\\.git\\worktree-guard\\state.json 'x'`,
    `Set-Content ../../.git/worktree-guard/allowlist.json 'x'`,
    `echo x > .git/worktree-guard/state.json`,
  ]) {
    assert.equal(decidePwsh({ command: cmd }, CTX12, null).kind, "deny", `must deny: ${cmd}`);
  }
});

// round-12 usability fix: only implicit pushes (no refspec, or HEAD/@) can move
// the current protected branch. Tag and named-branch refspecs stay open —
// "model cannot even push a release tag" forced users into the loop for no
// safety gain (a tag ref can never update master).
test("R12-2 push refspec precision while ON a protected branch", () => {
  const BIND12 = { worktree: P("C:/repo/.worktrees/worktree-x"), branch: "worktree-x" };
  const onProt = { command: "", currentBranchName: "master" };
  const t = (cmd) => decidePwsh({ ...onProt, command: cmd }, CTX12, BIND12, {});
  // implicit forms -> deny
  for (const cmd of ["git push", "git push origin", "git push https://github.com/x/y.git", "git push origin HEAD", "git push origin @:master"]) {
    assert.equal(t(cmd).kind, "deny", `must deny: ${cmd}`);
  }
  // explicit non-current refs -> allow (tags, other branches)
  for (const cmd of ["git push origin v0.2.0", "git push origin worktree-x", "git push origin --tags", "git push origin HEAD:worktree-x"]) {
    assert.equal(t(cmd).kind, "allow", `must allow: ${cmd}`);
  }
  // explicit protected refspec still denied by rule 1
  assert.equal(t("git push origin master").kind, "deny");
});

// round-12 live finding: a PowerShell redirect token (`2>&1`) after `git push`
// was parsed as a refspec — a bare push slipped through the net un-denied.
test("R12-3 push detection ignores PowerShell redirection tokens", () => {
  const onProt = { command: "", currentBranchName: "master" };
  const t = (cmd) => decidePwsh({ ...onProt, command: cmd }, CTX12, null, {});
  assert.equal(t("git push 2>&1 | Select-Object -First 3").kind, "deny", "bare push with redirect must stay denied");
  assert.equal(t("git push > out.log").kind, "deny");
  assert.equal(t("git push origin 2>&1").kind, "deny");
  assert.equal(t("git push origin v0.2.0 2>&1 | Out-Null").kind, "allow", "tag push with redirect stays open");
});
