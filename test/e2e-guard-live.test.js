// E2E live tests (guard full-path + plugin apply layer with mock cordis ctx).
// Complements integration.test.js with: shell net edge rows, junction escape,
// danger-full-access linkage, TTL authorization expiry, sidecar whitelist,
// post-execute marker pipeline, standing-line/session-start injection.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lifecycle from "../src/core/lifecycle.js";
import { decideToolCall, bustGuardContextCache } from "../src/guard.js";
import { apply } from "../src/index.js";
import { commonDir } from "../src/core/gitops.js";
import { updateState } from "../src/core/store.js";

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function makeRepo() {
  const d = await mkdtemp(join(tmpdir(), "wtg-e2e-"));
  sh(d, "git", ["init", "-b", "main"]);
  sh(d, "git", ["config", "user.email", "t@t"]);
  sh(d, "git", ["config", "user.name", "t"]);
  await writeFile(join(d, "a.txt"), "hello\n", "utf8");
  sh(d, "git", ["add", "."]);
  sh(d, "git", ["commit", "-m", "init", "-q"]);
  return d;
}
function mkExec({ tool, args, cwd, sessionId = "e1", parentSession = null }) {
  return {
    name: tool,
    arguments: args,
    callId: `call-${Math.random().toString(36).slice(2)}`,
    agent: { session: { header: { id: sessionId, cwd, parentSession } } },
  };
}
async function guard(exec, opts = {}) {
  const d = await decideToolCall(exec, opts);
  bustGuardContextCache();
  return d;
}

let repo, wt, cd;

before(async () => {
  repo = await makeRepo();
  const r = await lifecycle.create({ taskName: "e2e live", cwd: repo });
  wt = r.worktree;
  cd = await commonDir(wt);
  await lifecycle.enter({ path: wt, sessionId: "e1", cwd: wt });
});

after(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

// ---------- G 系列：守卫决策网全路径 ----------

test("G1 write 相对路径写本副本 -> allow", async () => {
  assert.equal((await guard(mkExec({ tool: "write", args: { file_path: "b.txt" }, cwd: wt }))).kind, "allow");
});

test("G2 write 空路径 -> deny（防 undefined 绕过）", async () => {
  assert.equal((await guard(mkExec({ tool: "edit", args: {}, cwd: wt }))).kind, "deny");
});

test("G3 write 跨副本 -> deny", async () => {
  const other = await lifecycle.create({ taskName: "other copy", cwd: repo });
  const d = await guard(mkExec({ tool: "write", args: { file_path: join(other.worktree, "x.txt") }, cwd: wt }));
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /跨副本|副本/);
});

test("G4 write .git 元数据 -> deny", async () => {
  assert.equal((await guard(mkExec({ tool: "write", args: { file_path: join(wt, ".git", "config") }, cwd: wt }))).kind, "deny");
});

test("G5 write 经 junction 指向主 checkout -> deny（物理身份）", async () => {
  const link = join(wt, "to-main");
  try {
    await symlink(repo, link, "junction").catch(() => symlink(repo, link, "dir"));
    const d = await guard(mkExec({ tool: "write", args: { file_path: join(link, "a.txt") }, cwd: wt }));
    assert.equal(d.kind, "deny");
    assert.match(d.reason, /主 checkout/);
  } finally {
    await rm(link, { force: true }).catch(() => {});
  }
});

test("G6 read 主 checkout warn -> allow + pendingMark 可经 callId 取走", async () => {
  const exec = mkExec({ tool: "read", args: { file_path: join(repo, "a.txt") }, cwd: wt });
  const d = await guard(exec, { readPolicy: "warn" });
  assert.equal(d.kind, "allow");
  const { takePendingMark } = await import("../src/guard.js");
  const m = takePendingMark(exec.callId);
  assert.match(m, /主 checkout/);
  assert.equal(takePendingMark(exec.callId), null, "取走后清空");
});

test("G7 grep 搜主 checkout -> allow + mark", async () => {
  const exec = mkExec({ tool: "grep", args: { pattern: "x", path: repo }, cwd: wt });
  const d = await guard(exec, { readPolicy: "warn" });
  assert.equal(d.kind, "allow");
  assert.ok(d.mark);
});

test("G8 pwsh: push 受保护分支 deny；push 本分支 allow", async () => {
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: "git push origin main" }, cwd: wt }))).kind, "deny");
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: "git push origin worktree-e2e-live" }, cwd: wt }))).kind, "allow");
});

test("G9 pwsh: 主根 cwd 上裸 push（当前分支 main）-> deny", async () => {
  const d = await guard(mkExec({ tool: "pwsh", args: { command: "git push" }, cwd: repo }));
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /受保护分支/);
});

test("G10 pwsh: git branch 涉及 worktree 分支 deny；无关分支 allow", async () => {
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: "git branch -d decoy worktree-e2e-live" }, cwd: wt }))).kind, "deny");
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: "git branch -d decoy" }, cwd: wt }))).kind, "allow");
});

test("G11 pwsh: git -C 绝对路径定向主 checkout -> deny；子目录相对定向 allow", async () => {
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: `git -C "${repo}" status` }, cwd: wt }))).kind, "deny");
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: "git -C . status" }, cwd: wt }))).kind, "allow");
});

test("G12 pwsh: 绑定态 checkout main -> deny；checkout 其他分支 allow", async () => {
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: "git checkout main" }, cwd: wt }))).kind, "deny");
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: "git checkout -b fresh" }, cwd: wt }))).kind, "allow");
});

test("G13 pwsh: shell 内 authorize-main 动词 -> deny（人工通道保护）", async () => {
  const d = await guard(mkExec({ tool: "pwsh", args: { command: "node wt.js authorize-main why not" }, cwd: wt }));
  assert.equal(d.kind, "deny");
  assert.match(d.reason, /人工通道|自授/);
});

test("G14 pwsh: Set-Content 相对逃逸进 .git/worktree-guard -> deny", async () => {
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: "Set-Content ../../.git/worktree-guard/state.json '{}'" }, cwd: wt }))).kind, "deny");
});

test("G15 pwsh: import 守卫模块 -> deny", async () => {
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: 'node -e "import(\'../src/core/store.js\')"' }, cwd: wt }))).kind, "deny");
});

test("G16 普通命令无误报：npm/pwsh 日常命令 -> allow", async () => {
  for (const c of ["npm test", "Get-ChildItem", "node script.js --input src/store.js"]) {
    assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: c }, cwd: wt }))).kind, "allow", c);
  }
});

test("G17 C9 链路：绑定 + danger-full-access -> 非 worktree_* deny；worktree_* 豁免", async () => {
  const mode = async () => "danger-full-access";
  assert.equal((await guard(mkExec({ tool: "write", args: { file_path: "b.txt" }, cwd: wt }), { sandboxModeOf: mode })).kind, "deny");
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: "git status" }, cwd: wt }), { sandboxModeOf: mode })).kind, "deny");
  assert.equal((await guard(mkExec({ tool: "worktree_status", args: {}, cwd: wt }), { sandboxModeOf: mode })).kind, "allow");
});

test("G18 TTL 授权：有效期内写主 checkout + push 放行；过期收回", async () => {
  await updateState(cd, {
    allow_main_writes: {
      allow_main_writes: true, allow_reason: "t", allow_by: "test",
      allow_at: new Date().toISOString(),
      allow_expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  bustGuardContextCache();
  assert.equal((await guard(mkExec({ tool: "write", args: { file_path: join(repo, "a.txt") }, cwd: wt }))).kind, "allow");
  assert.equal((await guard(mkExec({ tool: "pwsh", args: { command: "git push origin main" }, cwd: wt }))).kind, "allow");
  await updateState(cd, {
    allow_main_writes: {
      allow_main_writes: true, allow_reason: "t", allow_by: "test",
      allow_at: new Date(Date.now() - 120_000).toISOString(),
      allow_expires_at: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  bustGuardContextCache();
  assert.equal((await guard(mkExec({ tool: "write", args: { file_path: join(repo, "a.txt") }, cwd: wt }))).kind, "deny", "过期后必须收回");
});

test("G19 sidecar: main_write_whitelist glob 语义——docs/* 放行；目录前缀 docs/ 与非白名单路径 deny", async () => {
  await mkdir(join(repo, ".dsh"), { recursive: true });
  await writeFile(join(repo, ".dsh", "worktree-guard.json"), JSON.stringify({ main_write_whitelist: ["docs/*"] }), "utf8");
  await mkdir(join(repo, "docs"), { recursive: true });
  bustGuardContextCache();
  assert.equal((await guard(mkExec({ tool: "write", args: { file_path: join(repo, "docs", "n.md") }, cwd: wt }))).kind, "allow");
  assert.equal((await guard(mkExec({ tool: "write", args: { file_path: join(repo, "a.txt") }, cwd: wt }))).kind, "deny");
  // 语义记录：非 glob 的目录前缀不命中（需 docs/* 或 docs/**）
  await writeFile(join(repo, ".dsh", "worktree-guard.json"), JSON.stringify({ main_write_whitelist: ["docs/"] }), "utf8");
  bustGuardContextCache();
  assert.equal((await guard(mkExec({ tool: "write", args: { file_path: join(repo, "docs", "n.md") }, cwd: wt }))).kind, "deny");
  await rm(join(repo, ".dsh"), { recursive: true, force: true });
  bustGuardContextCache();
});

test("G20 sidecar: read_policy=strict 经 sidecar 生效", async () => {
  await mkdir(join(repo, ".dsh"), { recursive: true });
  await writeFile(join(repo, ".dsh", "worktree-guard.json"), JSON.stringify({ read_policy: "strict" }), "utf8");
  bustGuardContextCache();
  assert.equal((await guard(mkExec({ tool: "read", args: { file_path: join(repo, "a.txt") }, cwd: wt }))).kind, "deny");
  await rm(join(repo, ".dsh"), { recursive: true, force: true });
  bustGuardContextCache();
});

// ---------- P 系列：插件装配层 apply()（mock cordis ctx） ----------

function mockCtx() {
  const handlers = {};
  const registered = [];
  const injected = [];
  return {
    on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
    tools: {
      define: (spec) => spec,
      register: (def) => registered.push(def),
    },
    fs: {},
    _handlers: handlers,
    _registered: registered,
    _injected: injected,
    async fire(ev, ...args) {
      let last;
      const next = (v) => { last = v ?? { kind: "allow" }; return last; };
      for (const fn of handlers[ev] ?? []) last = await fn(...args, next);
      return last;
    },
    agentOf: (header) => ({ session: { header }, inject: (t) => injected.push(t) }),
  };
}

test("P1 apply 注册 worktree_* 工具且含 ask 门工具", async () => {
  const ctx = mockCtx();
  apply(ctx, {});
  const names = ctx._registered.map((t) => t.name);
  for (const n of ["worktree_create", "worktree_enter", "worktree_exit", "worktree_status", "worktree_authorize_main", "worktree_allow"]) {
    assert.ok(names.includes(n), n);
  }
});

test("P2 pre-execute: write 主 checkout -> deny 且不调用 next", async () => {
  const ctx = mockCtx();
  apply(ctx, {});
  const exec = { name: "write", arguments: { file_path: join(repo, "a.txt") }, callId: "p2", agent: { session: { header: { id: "e1", cwd: wt } } } };
  const out = await ctx.fire("tools/pre-execute", exec);
  assert.equal(out.kind, "deny");
});

test("P3 pre-execute: worktree_authorize_main -> ask（机械人闸）", async () => {
  const ctx = mockCtx();
  apply(ctx, {});
  const exec = { name: "worktree_authorize_main", arguments: { reason: "x" }, callId: "p3", agent: { session: { header: { id: "e1", cwd: wt } } } };
  const out = await ctx.fire("tools/pre-execute", exec);
  assert.equal(out.kind, "ask");
});

test("P4 post-execute: 读主 checkout 后标记附加到 additionalContexts", async () => {
  const ctx = mockCtx();
  apply(ctx, { readPolicy: "warn" });
  const exec = { name: "read", arguments: { file_path: join(repo, "a.txt") }, callId: "p4", agent: { session: { header: { id: "e1", cwd: wt } } } };
  await ctx.fire("tools/pre-execute", exec);
  const out = await ctx.fire("tools/post-execute", exec, { content: [] }, async () => ({ content: [] }));
  assert.ok(out.additionalContexts?.some((c) => String(c.text ?? c).includes("主 checkout")));
});

test("P5 agent/pre-step: 绑定会话注入 standing line 且仅一次", async () => {
  const ctx = mockCtx();
  apply(ctx, {});
  const agent = ctx.agentOf({ id: "e1", cwd: wt });
  await ctx.fire("agent/pre-step", agent);
  await ctx.fire("agent/pre-step", agent);
  const lines = ctx._injected.filter((t) => t.includes("worktree 副本"));
  assert.equal(lines.length, 1);
});

test("P6 session-start: rooted 会话注入启动引导（含 parentSession 继承）", async () => {
  const ctx = mockCtx();
  apply(ctx, {});
  const agent = ctx.agentOf({ id: "e1", cwd: wt });
  await ctx.fire("agent/session-start", agent);
  assert.ok(ctx._injected.some((t) => t.includes("本会话根是 worktree 副本")));
  const child = ctx.agentOf({ id: "child-1", cwd: wt, parentSession: "e1" });
  await ctx.fire("agent/session-start", child);
  assert.ok(ctx._injected.filter((t) => t.includes("本会话根是 worktree 副本")).length >= 2, "继承绑定也得到引导");
});

test("P7 enable=false -> 零挂载", async () => {
  const ctx = mockCtx();
  apply(ctx, { enable: false });
  assert.equal(Object.keys(ctx._handlers).length, 0);
  assert.equal(ctx._registered.length, 0);
});
