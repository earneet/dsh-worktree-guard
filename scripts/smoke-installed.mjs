// scripts/smoke-installed.mjs — executable smoke test for an INSTALLED copy of
// dsh-worktree-guard (doc/smoke-test.md is the case design; this runs T0-T2).
//
// WHY a separate smoke when `npm test` exists: npm test drives the REPO source.
// The reporter of issue #5 hit the INSTALLED artifact through the tool wire —
// a boundary the repo tests never touched. This script therefore imports every
// module from the install path (default: the desktop profile's node_modules,
// which since 0.2.4 is a link: junction to this checkout; override with
// WTG_SMOKE_PATH to smoke any other install, e.g. an npm-pack extraction).
//
// Exit code 0 = all cases pass. No network, no host restart needed (T3 — the
// live-host checklist — is manual and lives in the doc).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, statSync, readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const INSTALL = process.env.WTG_SMOKE_PATH
  ?? join(process.env.USERPROFILE ?? process.env.HOME, ".dsh", "profiles", "desktop", "node_modules", "dsh-worktree-guard");

const results = [];
const ok = (id, name, cond, detail = "") => {
  results.push({ id, name, pass: !!cond, detail });
  console.log(`${cond ? "[PASS]" : "[FAIL]"} ${id} ${name}${cond ? "" : `  <<< ${detail}`}`);
};
const mod = async (rel) => await import(pathToFileURL(join(INSTALL, rel)).href);

function sh(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function makeRepo() {
  const d = await mkdtemp(join(tmpdir(), "wtg-smoke-"));
  sh(d, ["init", "-b", "main"]);
  sh(d, ["config", "user.email", "t@t"]);
  sh(d, ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "hello\n", "utf8");
  sh(d, ["add", "."]);
  sh(d, ["commit", "-m", "init", "-q"]);
  return d;
}
const mkExec = (tool, args, cwd, sessionId) => ({
  name: tool, arguments: args, callId: `smoke-${sessionId}-${Math.random()}`,
  agent: { session: { header: { id: sessionId, cwd, parentSession: null } } },
});

async function fileHashes(root) {
  const out = {};
  const walk = async (dir, rel) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), r);
      else out[r] = createHash("sha256").update(readFileSync(join(dir, e.name))).digest("hex");
    }
  };
  await walk(root, "");
  return out;
}

// ---------------- T0: install integrity ----------------
console.log(`\n=== T0 安装完整性（install: ${INSTALL}）===`);
{
  const st = statSync(INSTALL);
  ok("S0.1", "安装目录存在且可达（junction 或实体目录）", st.isDirectory());
  const pkg = JSON.parse(await readFile(join(INSTALL, "package.json"), "utf8"));
  const repoPkg = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));
  ok("S0.2", `版本 = 本地最新（${repoPkg.version}）`, pkg.version === repoPkg.version, `installed=${pkg.version}`);
  const idx = await mod("src/index.js");
  const need = ["name", "inject", "Config", "apply", "decideToolCall", "repoConfig"];
  // schemastery Schema: a callable function with .meta (NOT .validate)
  ok("S0.3", "入口导出齐全（Config 为 schemastery Schema：可调用 + .meta）",
    need.every((k) => k in idx) && typeof idx.Config === "function" && typeof idx.Config?.meta === "object");
  // dependency resolution EXACTLY as src/index.js does it: resolve from the
  // importing file's location (junction realpath => the checkout's node_modules)
  let resolved = null;
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(join(INSTALL, "src", "index.js"));
    resolved = req.resolve("@deepseek-ai/schemastery");
  } catch { /* leave null */ }
  ok("S0.4", "运行时依赖（@deepseek-ai/schemastery）按 index.js 的解析规则可达", !!resolved, resolved ?? "resolve failed");
  const [instH, repoH] = await Promise.all([fileHashes(join(INSTALL, "src")), fileHashes(join(REPO, "src"))]);
  const drift = Object.keys(repoH).filter((k) => instH[k] !== repoH[k]);
  ok("S0.5", `src/ 与仓库逐文件一致（${Object.keys(repoH).length} 个文件）`, drift.length === 0, drift.join(","));
}

// ---------------- T1: decision core (installed code, pure) ----------------
console.log("\n=== T1 决策核心（安装副本纯函数）===");
{
  const { decideWrite, decidePwsh, makeContext } = await mod("src/core/decision.js");
  const MAIN = "F:/smoke/repo";
  const WT_A = `${MAIN}/.worktrees/worktree-alpha`;
  const WT_B = `${MAIN}/.worktrees/worktree-beta`;
  const ctx = makeContext({ mainRoot: MAIN, commonDir: `${MAIN}/.git`, worktrees: [{ root: WT_A, name: "worktree-alpha" }, { root: WT_B, name: "worktree-beta" }] });
  const onMain = { currentBranchName: "master", cwd: MAIN };

  const d1 = decideWrite(`${WT_A}/x.ts`, MAIN, ctx, { worktree: WT_A }, {});
  ok("S1.1a", "绑定副本内写入 → allow", d1.kind === "allow", d1.reason);
  const d2 = decideWrite(`${WT_A}/x.ts`, MAIN, ctx, null, {});
  ok("S1.1b", "跨副本写入（未绑定）→ deny 且指引 enter 采用", d2.kind === "deny" && /worktree_enter/.test(d2.reason) && /采用/.test(d2.reason), d2.reason);

  const p1 = decidePwsh({ ...onMain, command: "git push origin master" }, ctx, null, {});
  ok("S1.2a", "未绑定主 checkout 推当前受保护分支 → allow+审计", p1.kind === "allow" && p1.audit === "allow_protected_push");
  const p2 = decidePwsh({ ...onMain, command: "git push origin master" }, ctx, { worktree: WT_A }, {});
  ok("S1.2b", "绑定会话推受保护分支 → deny", p2.kind === "deny");
  const p3 = decidePwsh({ ...onMain, command: "git push --dry-run origin master" }, ctx, { worktree: WT_A }, {});
  ok("S1.2c", "--dry-run 只读 → allow", p3.kind === "allow", p3.reason);
  const p4 = decidePwsh({ ...onMain, command: "git push -f origin master" }, ctx, null, {});
  ok("S1.2d", "--force 破坏性 → deny", p4.kind === "deny");

  const { isolationGrade, isolationReasons } = await mod("src/core/capabilities.js");
  ok("S1.3a", "隔离等级：rooted+围栏 = structural", isolationGrade({ mode: "workspace-write", binding: { worktree: WT_A }, cwd: WT_A }) === "structural");
  ok("S1.3b", "隔离等级：adopted = disciplinary 且原因点明", isolationGrade({ mode: "workspace-write", binding: { worktree: WT_A, mode: "adopted" }, cwd: MAIN }) === "disciplinary"
    && isolationReasons({ mode: "workspace-write", binding: { worktree: WT_A, mode: "adopted" }, cwd: MAIN }).includes("adopted-copy-not-root"));

  const { adoptWord, adoptPathArg, resolveBindingMode, BINDING_ADOPTED } = await mod("src/core/adopt.js");
  const { norm } = await mod("src/core/paths.js");
  const entries = [{ root: WT_A, prunable: false, locked: false }];
  const mode = resolveBindingMode({ binding: { worktree: WT_A }, cwd: MAIN, entries });
  ok("S1.4a", "绑定模式：嵌套副本 → adopted（rel 正确）", mode.kind === BINDING_ADOPTED && mode.rel === ".worktrees/worktree-alpha", JSON.stringify(mode));
  // adoptWord returns the NORMED copy path (drive letter lowercased on win32)
  ok("S1.4b", "词级采用：不发明逃逸（../、绝对路径、URL 均不改写）",
    adoptWord(".worktrees/worktree-alpha/../esc", mode) === null
    && adoptWord(`${MAIN}/x`, mode) === null
    && adoptWord("https://x/y", mode) === null
    && adoptWord(".worktrees/worktree-alpha", mode) === norm(WT_A));
  ok("S1.4c", "路径映射：'.worktrees/<名>/src/a.ts' → 副本内；'src/a.ts' 不动",
    adoptPathArg(".worktrees/worktree-alpha/src/a.ts", mode) === `${norm(WT_A)}/src/a.ts`
    && adoptPathArg("src/a.ts", mode) === "src/a.ts");
}

// ---------------- T2: tool-layer lifecycle (installed code) ----------------
console.log("\n=== T2 工具层全生命周期（安装副本 + wire 形状参数，临时仓库）===");
const repo = await makeRepo();
try {
  const { toolSpecs } = await mod("src/wt-tools.js");
  const { decideToolCall } = await mod("src/guard.js");
  const { standingLine, sessionStartText } = await mod("src/notices.js");
  const lifecycle = await mod("src/core/lifecycle.js");
  const { branchExists, listWorktrees } = await mod("src/core/gitops.js");
  const { norm } = await mod("src/core/paths.js");
  const specs = toolSpecs({
    sessionOf: (exec) => {
      const h = exec?.agent?.session?.header ?? {};
      return { id: h.id, cwd: h.cwd ?? repo, parentSession: null };
    },
    config: async () => ({}),
    hostCapabilities: async () => ({ sandboxMode: "workspace-write" }),
    switchSession: async () => ({ ok: false, reason: "smoke: host seam not wired" }),
  });
  const specOf = (n) => specs.find((s) => s.name === n);

  // S2.1 create
  const created = await specOf("worktree_create").execute(
    { task_name: "smoke a", task_brief: "smoke brief" },
    mkExec("worktree_create", {}, repo, "smoke-s"),
  );
  ok("S2.1", "worktree_create{task_name,task_brief} → 副本+分支+简报+等级提示",
    !created.error && created.branch === "worktree-smoke-a" && existsSync(join(created.worktree, ".dsh", "task-brief.md"))
    && /worktree_enter/.test(created.summary) && created.isolation === "disciplinary",
    created.error ?? JSON.stringify(created).slice(0, 120));

  // S2.2 status (unbound)
  const st1 = await specOf("worktree_status").execute({}, mkExec("worktree_status", {}, repo, "smoke-s2"));
  ok("S2.2", "worktree_status（未绑定）→ copies 在列、isolation=disciplinary、next_actions[0] 指向 enter",
    st1.copies.some((c) => c.branch === "worktree-smoke-a") && st1.isolation === "disciplinary"
    && /worktree_enter/.test(st1.next_actions[0] ?? ""), JSON.stringify(st1.isolation_reasons));

  // S2.3 enter → adopted
  const entered = await specOf("worktree_enter").execute({ path: created.worktree }, mkExec("worktree_enter", {}, repo, "smoke-s3"));
  ok("S2.3", "worktree_enter（主 checkout 会话，嵌套副本）→ 就地采用，无需新开工作区",
    entered.bound === true && entered.adopted === true && entered.mode === "adopted" && entered.isolation === "disciplinary",
    JSON.stringify(entered).slice(0, 120));

  // S2.4 decision net under adoption
  const opts = {
    sandboxModeOf: () => "workspace-write",
    hostCapabilitiesOf: async () => ({ workspaceRegistry: true, directoryPicker: true, sandboxMode: "workspace-write" }),
  };
  const wIn = await decideToolCall(mkExec("write", { file_path: join(created.worktree, "src", "n.ts") }, repo, "smoke-s3"), opts);
  ok("S2.4a", "采用后写副本内 → allow", wIn.kind === "allow", wIn.reason);
  const wMain = await decideToolCall(mkExec("write", { file_path: join(repo, "src", "a.ts") }, repo, "smoke-s3"), opts);
  ok("S2.4b", "采用后写主 checkout → deny 且给出副本前缀重试路径（单轮可执行）",
    wMain.kind === "deny" && /采用模式/.test(wMain.reason) && /\.worktrees[\\/]worktree-smoke-a[\\/]src[\\/]a\.ts/.test(wMain.reason),
    wMain.reason);
  const other = await lifecycle.create({ taskName: "smoke other", cwd: repo });
  const wOther = await decideToolCall(mkExec("write", { file_path: join(other.worktree, "x.ts") }, repo, "smoke-s3"), opts);
  ok("S2.4c", "写其他副本 → 仍 deny（跨副本）", wOther.kind === "deny" && /跨副本/.test(wOther.reason));
  const pushProtected = await decideToolCall(
    mkExec("bash", { command: "bash -c 'cd .worktrees/worktree-smoke-a && git push origin main'" }, repo, "smoke-s3"), opts);
  ok("S2.4d", "采用态经副本路由推受保护分支 → deny", pushProtected.kind === "deny", pushProtected.reason);
  const dryRun = await decideToolCall(mkExec("bash", { command: "git push --dry-run origin main" }, repo, "smoke-s3"), opts);
  ok("S2.4e", "--dry-run → allow（只读）", dryRun.kind === "allow", dryRun.reason);
  const danger = await decideToolCall(
    mkExec("write", { file_path: join(created.worktree, "x.ts") }, repo, "smoke-s3"),
    { sandboxModeOf: () => "danger-full-access", hostCapabilitiesOf: async () => ({ sandboxMode: "danger-full-access" }) },
  );
  ok("S2.4f", "danger-full-access 下 adopted 绑定不再被 C9 一刀切（路由照常；rooted 仍受 C9 网）", danger.kind === "allow", danger.reason);

  // S2.5 status (adopted)
  const st2 = await specOf("worktree_status").execute({}, mkExec("worktree_status", {}, repo, "smoke-s3"));
  ok("S2.5", "worktree_status（采用后）→ mode=adopted、原因含 adopted-copy-not-root",
    st2.mode === "adopted" && st2.isolation_reasons.includes("adopted-copy-not-root"), JSON.stringify(st2));

  // S2.6/S2.13 notices
  ok("S2.6a", "standingLine（adopted）说明采用模式与前缀路径用法", /采用模式/.test(standingLine({ worktree: created.worktree, branch: "worktree-smoke-a", mode: "adopted" })));
  const startText = await sessionStartText({ cwd: repo, sessionId: "smoke-fresh", hostCaps: { workspaceRegistry: true }, sandboxMode: "workspace-write" });
  ok("S2.6b", "sessionStartText（存在副本未绑定）→ ≤3 行、点名等级与 enter 路径",
    !!startText && startText.split("\n").length <= 3 && /隔离等级/.test(startText) && /worktree_enter/.test(startText), startText ?? "(null)");

  // S2.7 remove gate + full removal (issue #5 core)
  const rmGate = await specOf("worktree_remove").execute({ path: created.worktree }, mkExec("worktree_remove", {}, repo, "smoke-s4"));
  ok("S2.7a", "worktree_remove 无 confirm_remove → needConfirm（门不变）", rmGate.removed === false && rmGate.needConfirm === true);
  const rmDone = await specOf("worktree_remove").execute(
    { path: created.worktree, confirm_remove: true, delete_branch: true },
    mkExec("worktree_remove", {}, repo, "smoke-s4"),
  );
  const gone = !(await listWorktrees(repo)).entries.some((e) => norm(e.root) === norm(created.worktree));
  ok("S2.7b", "worktree_remove{confirm_remove:true,delete_branch:true}（snake_case 全链路）→ 副本删除+已合并分支删除（issue #5）",
    rmDone.error === undefined && rmDone.removed === true && rmDone.branch === "worktree-smoke-a"
    && !(await branchExists(repo, "worktree-smoke-a")) && gone,
    rmDone.error ?? JSON.stringify(rmDone).slice(0, 120));

  // S2.8 unmerged protection
  const b = await lifecycle.create({ taskName: "smoke unmerged", cwd: repo });
  await writeFile(join(b.worktree, "b.txt"), "x\n");
  sh(b.worktree, ["add", "."]);
  sh(b.worktree, ["commit", "-m", "ahead", "-q"]);
  const rmUnmerged = await specOf("worktree_remove").execute(
    { path: b.worktree, confirm_remove: true, delete_branch: true },
    mkExec("worktree_remove", {}, repo, "smoke-s5"),
  );
  ok("S2.8a", "未合并 + delete_branch → 整个删除被拒（merged-only 硬规则）",
    rmUnmerged.removed === false && /未合并/.test(rmUnmerged.message ?? ""));
  const rmKeepBranch = await specOf("worktree_remove").execute(
    { path: b.worktree, confirm_remove: true },
    mkExec("worktree_remove", {}, repo, "smoke-s5"),
  );
  ok("S2.8b", "不带 delete_branch 重试 → 副本删、分支保留",
    rmKeepBranch.removed === true && (await branchExists(repo, "worktree-smoke-unmerged")));
  sh(repo, ["branch", "-D", "worktree-smoke-unmerged"]); // cleanup

  // S2.9 rooted enter + exit(remove)
  const d = await lifecycle.create({ taskName: "smoke rooted", cwd: repo });
  const enterRooted = await specOf("worktree_enter").execute({ path: d.worktree }, mkExec("worktree_enter", {}, d.worktree, "smoke-s6"));
  ok("S2.9a", "会话根=副本 → rooted 绑定（isolation=structural）",
    enterRooted.bound === true && enterRooted.adopted === undefined && enterRooted.isolation === "structural", JSON.stringify(enterRooted));
  const exited = await specOf("worktree_exit").execute({ action: "remove" }, mkExec("worktree_exit", {}, d.worktree, "smoke-s6"));
  ok("S2.9b", "worktree_exit{action:remove} → 解绑+副本+已合并分支全清（内部 camelCase 路径）",
    exited.exited === true && exited.result?.removed === true && !(await branchExists(repo, "worktree-smoke-rooted")),
    exited.error ?? JSON.stringify(exited).slice(0, 120));

  // S2.10 prune
  const pr = await specOf("worktree_prune").execute({ dry_run: true }, mkExec("worktree_prune", {}, repo, "smoke-s7"));
  ok("S2.10", "worktree_prune{dry_run:true} → dryRun=true 无错", pr.dryRun === true && pr.error === undefined, pr.error);

  // S2.11 gated tools (#1 regression)
  const neverOpts = { approvalPolicyOf: async () => "never" };
  const gated = await decideToolCall(mkExec("worktree_authorize_main", { reason: "smoke" }, repo, "smoke-s8"), neverOpts);
  ok("S2.11", "approval=never 会话调 worktree_authorize_main → deny 且指向人工通道（不再返回注定失败的 ask）",
    gated.kind === "deny" && /禁用/.test(gated.reason) && /wt\.js/.test(gated.reason), gated.reason?.slice(0, 100));
  const askGated = await decideToolCall(mkExec("worktree_authorize_main", { reason: "smoke" }, repo, "smoke-s8"), { approvalPolicyOf: async () => "ask" });
  ok("S2.11b", "approval=ask 会话 → ask（弹窗确认，P4 门保留）", askGated.kind === "ask");

  // S2.12 allow list
  const allowList = await specOf("worktree_allow").execute({ action: "list" }, mkExec("worktree_allow", {}, repo, "smoke-s9"));
  ok("S2.12", "worktree_allow{action:list} → entries 返回", allowList.action === "list" && typeof allowList.entries === "object", allowList.error);

  // S2.14 audit trail exists (the durable copy lives in the session log; the
  // jsonl convenience copy must have grown during the lifecycle above)
  const auditPath = join(repo, ".git", "worktree-guard", "audit.jsonl");
  const audit = await readFile(auditPath, "utf8");
  ok("S2.14", "审计落盘（create/enter[mode:adopted]/remove 均有记录）",
    /"type": ?"create"/.test(audit) && /"mode": ?"adopted"/.test(audit) && /"type": ?"remove"/.test(audit));
} finally {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
}

// ---------------- summary ----------------
const fail = results.filter((r) => !r.pass);
console.log(`\n=== 冒烟结果：${results.length - fail.length}/${results.length} 通过 ===`);
if (fail.length) {
  console.log("失败用例：\n" + fail.map((f) => `  ${f.id} ${f.name}: ${f.detail}`).join("\n"));
  process.exit(1);
}
