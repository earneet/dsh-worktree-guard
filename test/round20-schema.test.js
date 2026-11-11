// round-20 (0.2.4, live-T3 findings): the HOST validates every tool's execute
// return against its output.schema (additionalProperties:false) — a schema that
// lags behind execute BREAKS the tool for real callers while offline tests that
// call execute directly stay green. worktree_create was exactly that in the
// 0.2.4 build (isolation/next_steps/summary undeclared → every live call died),
// caught only by the T3 live checklist. This round enforces schema↔return
// lockstep OFFLINE for every tool on every reachable return shape.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolSpecs } from "../src/wt-tools.js";

function sh(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function makeRepo() {
  const d = await mkdtemp(join(tmpdir(), "wtg-r20-"));
  sh(d, ["init", "-b", "main"]);
  sh(d, ["config", "user.email", "t@t"]);
  sh(d, ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "hello\n", "utf8");
  sh(d, ["add", "."]);
  sh(d, ["commit", "-m", "init", "-q"]);
  return d;
}
const mkExec = (tool, args, cwd, sessionId) => ({
  name: tool, arguments: args, callId: `r20-${sessionId}-${Math.random()}`,
  agent: { session: { header: { id: sessionId, cwd, parentSession: null } } },
});

/** Minimal checker for the S.obj subset the host validates against. */
function checkValue(value, schema, path, errs) {
  if (!schema || typeof schema !== "object") return;
  if (schema.oneOf) {
    const okOne = schema.oneOf.some((s) => typeOf(value) === s.type || (s.type === "null" && value === null));
    if (!okOne) errs.push(`${path}: value ${JSON.stringify(value)?.slice(0, 40)} matches no oneOf branch`);
    return;
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errs.push(`${path}: expected object, got ${typeOf(value)}`);
      return;
    }
    const props = schema.properties ?? {};
    for (const k of Object.keys(value)) {
      if (schema.additionalProperties === false && !(k in props)) errs.push(`${path}.${k}: returned but NOT declared in output schema (host would reject this tool call)`);
    }
    for (const k of schema.required ?? []) if (value[k] === undefined) errs.push(`${path}.${k}: required by schema but missing`);
    for (const [k, sub] of Object.entries(props)) if (value[k] !== undefined) checkValue(value[k], sub, `${path}.${k}`, errs);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) { errs.push(`${path}: expected array`); return; }
    if (schema.items) value.forEach((v, i) => checkValue(v, schema.items, `${path}[${i}]`, errs));
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  if (schema.type && typeOf(value) !== schema.type) errs.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
}
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

let repo;
before(async () => { repo = await makeRepo(); });
after(async () => { await rm(repo, { recursive: true, force: true }).catch(() => {}); });

test("R20-1 每个工具的所有可达返回形状都符合自己的 output schema", async () => {
  const helpers = {
    sessionOf: (exec) => {
      const h = exec?.agent?.session?.header ?? {};
      return { id: h.id, cwd: h.cwd ?? repo, parentSession: null };
    },
    config: async () => ({}),
    hostCapabilities: async () => ({ sandboxMode: "workspace-write" }),
    switchSession: async () => ({ ok: false, reason: "not wired" }),
  };
  const specs = toolSpecs(helpers);
  const specOf = (n) => specs.find((s) => s.name === n);
  const cases = [];

  const created = await specOf("worktree_create").execute({ task_name: "r20 schema" }, mkExec("worktree_create", {}, repo, "r20-s"));
  cases.push(["create(adopted-host)", created]);

  const entered = await specOf("worktree_enter").execute({ path: created.worktree }, mkExec("worktree_enter", {}, repo, "r20-s"));
  cases.push(["enter(adopted)", entered]);

  cases.push(["status(adopted)", await specOf("worktree_status").execute({}, mkExec("worktree_status", {}, repo, "r20-s"))]);

  cases.push(["remove(gate)", await specOf("worktree_remove").execute({ path: created.worktree }, mkExec("worktree_remove", {}, repo, "r20-s"))]);
  cases.push(["remove(done)", await specOf("worktree_remove").execute(
    { path: created.worktree, confirm_remove: true, delete_branch: true },
    mkExec("worktree_remove", {}, repo, "r20-s"),
  )]);

  // exit shapes: no binding -> message; with binding -> worktree
  cases.push(["exit(none)", await specOf("worktree_exit").execute({ action: "keep" }, mkExec("worktree_exit", {}, repo, "r20-s2"))]);
  const c2 = await specOf("worktree_create").execute({ task_name: "r20 exit" }, mkExec("worktree_create", {}, repo, "r20-s3"));
  await specOf("worktree_enter").execute({ path: c2.worktree }, mkExec("worktree_enter", {}, repo, "r20-s3"));
  cases.push(["exit(keep)", await specOf("worktree_exit").execute({ action: "keep" }, mkExec("worktree_exit", {}, repo, "r20-s3"))]);

  cases.push(["prune(dry)", await specOf("worktree_prune").execute({ dry_run: true }, mkExec("worktree_prune", {}, repo, "r20-s4"))]);
  cases.push(["authorize", await specOf("worktree_authorize_main").execute({ reason: "r20", ttl_minutes: 1 }, mkExec("worktree_authorize_main", {}, repo, "r20-s5"))]);
  cases.push(["revoke", await specOf("worktree_revoke_main").execute({}, mkExec("worktree_revoke_main", {}, repo, "r20-s5"))]);
  cases.push(["allow(add)", await specOf("worktree_allow").execute({ action: "add", path: "docs/*", reason: "r20", ttl_minutes: 1 }, mkExec("worktree_allow", {}, repo, "r20-s6"))]);
  cases.push(["allow(list)", await specOf("worktree_allow").execute({ action: "list" }, mkExec("worktree_allow", {}, repo, "r20-s6"))]);
  cases.push(["enter(error)", await specOf("worktree_enter").execute({ path: join(repo, "no-such-copy") }, mkExec("worktree_enter", {}, repo, "r20-s7"))]);

  // refuse shape (copy outside the session root cannot be adopted)
  const elsewhere = await mkdtemp(join(tmpdir(), "wtg-r20-out-"));
  try {
    sh(repo, ["worktree", "add", "-b", "worktree-r20-outside", join(elsewhere, "copy"), "main"]);
    cases.push(["enter(refused)", await specOf("worktree_enter").execute({ path: join(elsewhere, "copy") }, mkExec("worktree_enter", {}, repo, "r20-s8"))]);
    sh(repo, ["worktree", "remove", "--force", join(elsewhere, "copy")]);
  } finally {
    await rm(elsewhere, { recursive: true, force: true }).catch(() => {});
  }

  const failures = [];
  const specFor = {
    "create(adopted-host)": "worktree_create", "enter(adopted)": "worktree_enter", "status(adopted)": "worktree_status",
    "remove(gate)": "worktree_remove", "remove(done)": "worktree_remove", "exit(none)": "worktree_exit", "exit(keep)": "worktree_exit",
    "prune(dry)": "worktree_prune", authorize: "worktree_authorize_main", revoke: "worktree_revoke_main",
    "allow(add)": "worktree_allow", "allow(list)": "worktree_allow", "enter(error)": "worktree_enter", "enter(refused)": "worktree_enter",
  };
  for (const [name, value] of cases) {
    const spec = specOf(specFor[name]);
    const errs = [];
    checkValue(value, spec.output.schema, name, errs);
    if (errs.length) failures.push(...errs);
  }
  assert.deepEqual(failures, [], `schema↔return drift (the host would reject these live):\n${failures.join("\n")}`);
  // cleanup stray copy from exit(keep)
  sh(repo, ["worktree", "remove", "--force", c2.worktree]);
  sh(repo, ["branch", "-D", "worktree-r20-exit"]);
});
