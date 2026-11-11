// round-19 (0.2.4, issue #5): worktree_remove was UNUSABLE through the tool
// interface — the wire schema is snake_case (confirm_remove/delete_branch) but
// lifecycle.remove takes camelCase, and execute passed `...args` through
// unmapped, so confirmRemove was always undefined and the tool answered
// "需确认：confirm_remove:true 后重试" forever (the reporter looped 4x).
//
// Why 230 tests missed it: every prior remove test called lifecycle.remove
// directly (camelCase) or the CLI (which maps its own argv). This round drives
// the TOOL layer with wire-shaped (snake_case) arguments — the boundary the
// reporter actually hit — and sweeps every other tool for the same class of
// bug (an `...args` passthrough across a naming boundary).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolSpecs } from "../src/wt-tools.js";
import * as lifecycle from "../src/core/lifecycle.js";
import { branchExists } from "../src/core/gitops.js";
import { norm } from "../src/core/paths.js";

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function makeRepo() {
  const d = await mkdtemp(join(tmpdir(), "wtg-r19-"));
  sh(d, "git", ["init", "-b", "main"]);
  sh(d, "git", ["config", "user.email", "t@t"]);
  sh(d, "git", ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "hello\n", "utf8");
  sh(d, "git", ["add", "."]);
  sh(d, "git", ["commit", "-m", "init", "-q"]);
  return d;
}
function mkExec(tool, args, cwd, sessionId) {
  return { name: tool, arguments: args, callId: `r19-${sessionId}-${Math.random()}`, agent: { session: { header: { id: sessionId, cwd, parentSession: null } } } };
}
function helpersFor(cwd) {
  return {
    sessionOf: (exec) => {
      const h = exec?.agent?.session?.header ?? {};
      return { id: h.id, cwd: h.cwd ?? cwd, parentSession: null };
    },
    config: async () => ({}),
    hostCapabilities: async () => ({ sandboxMode: "workspace-write" }),
    switchSession: async () => ({ ok: false, reason: "not wired" }),
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

test("R19-1 缺确认参数 -> needConfirm（门本身不变），且文案只在此时出现", async () => {
  const created = await lifecycle.create({ taskName: "r19 gate", cwd: repo });
  const remove = specOf(toolSpecs(helpersFor(repo)), "worktree_remove");
  const out = await remove.execute({ path: created.worktree }, mkExec("worktree_remove", {}, repo, "r19-1"));
  assert.equal(out.removed, false);
  assert.equal(out.needConfirm, true);
  assert.match(remove.output.render({}, out)[0].text, /confirm_remove:true/);
  // the copy is untouched
  assert.ok(await branchExists(repo, "worktree-r19-gate"));
});

test("R19-2 issue #5 回归：confirm_remove:true（snake_case）真正生效并删除副本+已合并分支", async () => {
  const created = await lifecycle.create({ taskName: "r19 kill", cwd: repo });
  // branch is at the same commit as main => merged => deletable
  const remove = specOf(toolSpecs(helpersFor(repo)), "worktree_remove");
  const out = await remove.execute(
    { path: created.worktree, confirm_remove: true, delete_branch: true },
    mkExec("worktree_remove", {}, repo, "r19-2"),
  );
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.removed, true, JSON.stringify(out));
  assert.equal(out.branch, "worktree-r19-kill");
  assert.equal(await branchExists(repo, "worktree-r19-kill"), false, "merged branch must be deleted");
  const { entries } = await import("../src/core/gitops.js").then((m) => m.listWorktrees(repo));
  assert.ok(!entries.some((e) => norm(e.root) === norm(created.worktree)), "copy must be unregistered");
});

test("R19-3 confirm_remove:true + delete_branch:true 但分支未合并 -> 整个删除被拒（merged-only 保护）", async () => {
  const created = await lifecycle.create({ taskName: "r19 unmerged", cwd: repo });
  // advance the copy branch beyond main => NOT merged
  await writeFile(join(created.worktree, "b.txt"), "x\n");
  sh(created.worktree, "git", ["add", "."]);
  sh(created.worktree, "git", ["commit", "-m", "ahead", "-q"]);
  const remove = specOf(toolSpecs(helpersFor(repo)), "worktree_remove");
  const out = await remove.execute(
    { path: created.worktree, confirm_remove: true, delete_branch: true },
    mkExec("worktree_remove", {}, repo, "r19-3"),
  );
  // designed behaviour: delete_branch on an unmerged branch refuses the WHOLE
  // removal (copy + branch both intact) — merged-only is a hard rule
  assert.equal(out.removed, false, JSON.stringify(out));
  assert.match(out.message, /未合并/);
  assert.equal(await branchExists(repo, "worktree-r19-unmerged"), true);
  // retrying WITHOUT delete_branch removes the copy and keeps the branch
  const out2 = await remove.execute(
    { path: created.worktree, confirm_remove: true },
    mkExec("worktree_remove", {}, repo, "r19-3b"),
  );
  assert.equal(out2.removed, true, JSON.stringify(out2));
  assert.equal(await branchExists(repo, "worktree-r19-unmerged"), true);
});

test("R19-4 exit(action:remove) 内部路径不受影响（camelCase 直调）", async () => {
  const created = await lifecycle.create({ taskName: "r19 exit", cwd: repo });
  await lifecycle.enter({ path: created.worktree, sessionId: "r19-4", cwd: created.worktree });
  const exit = specOf(toolSpecs(helpersFor(created.worktree)), "worktree_exit");
  const out = await exit.execute({ action: "remove" }, mkExec("worktree_exit", {}, created.worktree, "r19-4"));
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.exited, true);
  assert.equal(out.result?.removed, true, JSON.stringify(out));
  assert.equal(await branchExists(repo, "worktree-r19-exit"), false, "merged via exit remove");
});

test("R19-5 参数映射一致性：全部工具的 execute 不再裸透传 ...args（源码级防线）", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/wt-tools.js", import.meta.url), "utf8");
  // an actual spread at a call boundary is `...args,` — comments may quote it
  assert.ok(!/\.\.\.args\s*,/.test(src), "wt-tools must not spread raw wire args into lifecycle (issue #5 class)");
  // and the sibling mappings the issue asked to re-verify stay explicit
  for (const frag of [
    "taskName: args.task_name",
    "dryRun: !!args.dry_run",
    "ttlMinutes: Number(args.ttl_minutes)",
    "confirmRemove: args.confirm_remove === true",
  ]) {
    assert.ok(src.includes(frag), `mapping drift: ${frag}`);
  }
  // smoke: the other wire-shaped happy paths still work through the TOOL layer
  const specs = toolSpecs(helpersFor(repo));
  const st = await specOf(specs, "worktree_status").execute({}, mkExec("worktree_status", {}, repo, "r19-5"));
  assert.ok(st.copies !== undefined);
  const pr = await specOf(specs, "worktree_prune").execute({ dry_run: true }, mkExec("worktree_prune", {}, repo, "r19-5"));
  assert.equal(pr.dryRun, true);
  const cr = await specOf(specs, "worktree_create").execute(
    { task_name: "r19 smoke", task_brief: "b" },
    mkExec("worktree_create", {}, repo, "r19-5"),
  );
  assert.ok(!cr.error, cr.error);
  assert.equal(cr.branch, "worktree-r19-smoke");
});
