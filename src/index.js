// index.js — cordis plugin entry: assembles the guard, tools, and notices.
// Layout per the design doc's assembly view (§4):
//   A/A' guard  -> ctx.on("tools/pre-execute")   (deny/ask only, args frozen by host)
//   C    tools  -> ctx.tools.register(worktree_* specs)
//   D    notices-> session-start inject, standing line, post-execute markers
// Shape follows the dsh-tool-todo lineage: export { name, inject, Config, apply }.
// Sidecar (<repo>/.dsh/worktree-guard.json) is merged INSIDE the guard (B1 fix),
// so repo-level read_policy/protected_branches/branchPrefix reach the net.
// Config MUST be a schemastery Schema — cordis resolveConfig calls .validate on
// it; a plain object fails plugin activation (found via real dsh install).
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { decideToolCall, takePendingMark, gateRejectionMark, isGatedTool } from "./guard.js";
import { toolSpecs } from "./wt-tools.js";
import { standingLine, sessionStartText } from "./notices.js";
import { resolveBinding } from "./core/binding.js";
import { probeHostCapabilities } from "./core/capabilities.js";
import { norm } from "./core/paths.js";
import * as lifecycle from "./core/lifecycle.js";
import { bustGuardContextCache } from "./guard.js";

export const name = "worktree-guard";
export const inject = ["tools"];

/**
 * `tools/post-execute` `additionalContexts` is `UserMessage[]` in the host
 * contract (verified in 0.1.5 and 0.2.1: MessageBase requires id/content/source;
 * a bare string makes the loop read `.source.kind` of undefined — the round-13
 * live smoke caught `Cannot read properties of undefined (reading 'kind')`).
 * Build a plain, version-tolerant user-role message.
 */
function contextMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: String(text) }],
    source: { kind: "user" },
  };
}

export const Config = z.object({
  enable: z.boolean().default(true),
  protectedBranches: z.array(z.string()).default(["master", "main"]),
  readPolicy: z.string().default("warn"), // warn | strict (sidecar may override)
});

export { loadSidecar as repoConfig } from "./core/sidecar.js";

/** Bounded insertion-ordered set (round-5 m4: unbounded session tracking grew forever). */
function boundedSet(cap) {
  const s = new Set();
  return {
    has: (k) => s.has(k),
    add(k) {
      s.add(k);
      if (s.size > cap) s.delete(s.keys().next().value);
    },
  };
}

/**
 * Issue #5: for an ADOPTED binding (session root = main checkout, copy nested
 * inside it) the host CANNOT be asked to rewrite tool args (C1: args are
 * frozen), so adoption never rewrites — the guard's deny copy carries the
 * copy-prefixed path instead (guard.js), which the model retries itself. The
 * sandbox accepts that path because the copy sits inside the write boundary.
 */

export function apply(ctx, config) {
  if (config.enable === false) return;

  // Ask-gate capability probe (C11): the approval service exposes the session's
  // effective policy (last logged approval/policy, else config default).
  // policy "never" means an ask can never be answered, so the guard denies with
  // the human-channel fallback instead (round-13 live finding). Missing service
  // / throw / non-string => undefined => the host owns ask semantics.
  const effectiveApprovalPolicy = async (session) => {
    try {
      if (typeof ctx.get !== "function" && !ctx.approval) return undefined;
      const approval = (typeof ctx.get === "function" ? ctx.get("approval") : undefined) ?? ctx.approval;
      if (!approval) return undefined;
      // overrideOf is sync in current hosts; tolerate an async seam too.
      const override = typeof approval.overrideOf === "function" ? await Promise.resolve(approval.overrideOf(session)) : undefined;
      const policy = override ?? approval.config?.policy ?? "ask";
      return typeof policy === "string" ? policy : undefined;
    } catch {
      return undefined;
    }
  };

  // Sandbox-mode capability probe (C9; also feeds the issue-#4 isolation grade).
  // Missing capability degrades to a no-op (P1). Async-resilient: hosts whose
  // resolve() returns a Promise still work.
  const sandboxModeOfHeader = async (header) => {
    try {
      if (typeof ctx.fs?.sandboxMode === "string") return ctx.fs.sandboxMode;
      const policy = typeof ctx.sandboxPolicy?.resolve === "function" ? await ctx.sandboxPolicy.resolve({ session: { header } }) : undefined;
      return policy?.mode;
    } catch {
      return undefined;
    }
  };
  // The tool layer receives `exec`, so the seam resolves the mode for the
  // calling session (a mode override is per session, never process-global).
  const headerOfExec = (exec) => exec?.agent?.session?.header ?? {};
  const probeCaps = (exec) => probeHostCapabilities((k) => ctx.get(k));
  // The last call the gate saw: the tool layer needs its session (per-session
  // sandbox mode) and its Agent (host directory moves). The gate always runs
  // before execute, so this is the caller; absent => honest "unknown".
  let lastExec = null;

  // Issue #4: move THIS session's directory into the copy with the host's own
  // API (ctx.workingDirectory.set). The guard never rewrites the sandbox
  // boundary itself — it records which directory was chosen, and reports back
  // honestly that the write boundary did not move with it.
  const switchSessionFor = async (exec, target) => {
    const agent = exec?.agent;
    const wd = typeof ctx.get === "function" ? ctx.get("workingDirectory") : undefined;
    if (!agent || typeof wd?.set !== "function") return { ok: false, reason: "宿主不支持会话目录切换（ctx.workingDirectory.set 不可用）" };
    const { listWorktrees } = await import("./core/gitops.js");
    const { entries } = await listWorktrees(target);
    const found = entries.find((e) => norm(e.root) === norm(target));
    if (!found) return { ok: false, reason: `不是已注册的 worktree：${target}` };
    if (found.locked) return { ok: false, reason: `副本被锁定（git worktree lock），宿主会拒绝切换到它：${target}` };
    const cwd = await wd.set(agent, target);
    const binding = await lifecycle.enter({ path: cwd ?? target, sessionId: exec.agent.session.header.id, cwd: cwd ?? target });
    bustGuardContextCache();
    return { ok: true, cwd: cwd ?? target, branch: binding.branch ?? null, boundaryMoved: false };
  };

  // ---- component A/A': safety net + read-domain guard (deny/ask only) ----
  ctx.on("tools/pre-execute", async (exec, next) => {
    lastExec = exec; // the tool layer needs the calling session, not a global
    const decision = await decideToolCall(exec, {
      protectedBranches: config.protectedBranches,
      readPolicy: config.readPolicy,
      sandboxModeOf: sandboxModeOfHeader,
      approvalPolicyOf: effectiveApprovalPolicy,
      hostCapabilitiesOf: async () => (await probeCaps(exec)),
    });
    if (decision.kind === "deny") return { kind: "deny", reason: decision.reason };
    if (decision.kind === "ask") return { kind: "ask", reason: decision.reason };
    return next({ kind: "allow" }); // markers travel via pendingMarks (P3 pipeline)
  });

  // ---- component D: markers via post-execute (read origin / gate rejection; P3) ----
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const mark = takePendingMark(exec?.callId);
    // Host refusals of gated tools run post-execute with isError:true; a
    // policy-"never" rejection is indistinguishable from a real decline in the
    // error text, so re-probe the policy and leave the one-line advisory
    // (round-13, P3). Probe only for the two gated names: overrideOf walks the
    // session log, and post-execute runs for EVERY tool call.
    const gateMark = isGatedTool(exec?.name)
      ? gateRejectionMark(exec, result, await effectiveApprovalPolicy(exec?.agent?.session))
      : null;
    // Older host lines may resolve `next()` to undefined (and may omit `next`
    // entirely); the host then reads `.kind` off our return — live smoke caught
    // `Cannot read properties of undefined (reading 'kind')` on the ask-rejection
    // path. Normalize to the documented `{kind:"accept"}` shape; a real `next()`
    // throw still propagates (post-execute failure is not ours to swallow).
    const out = typeof next === "function" ? await next() : undefined;
    const base = out && typeof out === "object" ? out : { kind: "accept" };
    const extra = [mark, gateMark].filter(Boolean).map(contextMessage);
    if (extra.length) {
      return { ...base, additionalContexts: [...(base.additionalContexts ?? []), ...extra] };
    }
    return base;
  });

  // ---- component D channel 2: standing status line — injected ONCE per bound
  //      session at its first step (sandbox-policy durable-context pattern) ----
  const standingInjected = boundedSet(1000);
  ctx.on("agent/pre-step", async (agent, next) => {
    const header = agent?.session?.header;
    if (header?.id && !standingInjected.has(header.id)) {
      standingInjected.add(header.id);
      try {
        const { commonDir } = await import("./core/gitops.js");
        const cd = await commonDir(header.cwd);
        const binding = await resolveBinding(cd, { sessionId: header.id, parentSession: header.parentSession });
        if (binding && typeof agent?.inject === "function") agent.inject(standingLine(binding));
      } catch { /* not a repo or resolution failure -> zero injection (P1) */ }
    }
    return next();
  });

  // ---- component D channel 3: session-start inject ----
  ctx.on("agent/session-start", async (agent, next) => {
    const header = agent?.session?.header;
    const text = await sessionStartText({
      cwd: header?.cwd,
      sessionId: header?.id,
      parentSession: header?.parentSession ?? null,
      // issue #4: a session that cannot root itself at a copy must learn its
      // real grade up front, not after two failed calls.
      hostCaps: await probeHostCapabilities((k) => ctx.get(k)).catch(() => ({})),
      sandboxMode: await sandboxModeOfHeader(header ?? {}),
    });
    const out = await next();
    if (text && typeof agent?.inject === "function") agent.inject(text);
    return out;
  });

  // ---- When a session leaves, stamp resolved_at on its OWN binding (C8).
  //      Never delete — a resumed session keeps its binding; prune stays the
  //      final recycler (design §3/§10). Emit-mode listener, self-contained: an
  //      observability callback must never break the host (fail-open).
  ctx.on("agent/disposed", async (payload) => {
    try {
      const h = payload?.agent?.session?.header;
      if (!h?.id || !h.cwd) return;
      const { commonDir } = await import("./core/gitops.js");
      const { readBinding, writeBinding } = await import("./core/store.js");
      const cd = await commonDir(h.cwd);
      const b = await readBinding(cd, h.id);
      if (b?.worktree && !b.resolved_at) {
        await writeBinding(cd, h.id, { ...b, resolved_at: new Date().toISOString() });
      }
    } catch { /* observability only */ }
  });

  // ---- component C: worktree_* tools ----
  const helpers = {
    sessionOf(exec) {
      const h = exec?.agent?.session?.header ?? {};
      return { id: h.id, cwd: h.cwd, parentSession: h.parentSession };
    },
    // sidecar is MAIN-ROOT based (a rooted session's cwd is the copy)
    config: async (cwd) => {
      const { listWorktrees } = await import("./core/gitops.js");
      const { loadSidecar } = await import("./core/sidecar.js");
      const { mainRoot } = await listWorktrees(cwd).catch(() => ({ mainRoot: null }));
      return mainRoot ? loadSidecar(mainRoot) : {};
    },
    // Issue #4: what can THIS host actually carry out (GUI workspace adoption,
    // session directory move, sandbox mode). Absent capability => the copy
    // degrades to "unavailable" instead of an unreachable recommendation.
    // Sessions resolve their own mode: the tool layer carries the caller's
    // session id (sessionOf), so the grade never reads another session's mode.
    hostCapabilities: async (sessionId) => {
      const exec = sessionId && lastExec?.agent?.session?.header?.id === sessionId ? lastExec : null;
      const header = exec ? headerOfExec(exec) : null;
      return { ...(await probeCaps(exec)), sandboxMode: header ? await sandboxModeOfHeader(header) : undefined };
    },
    // Issue #4: the one session move the guard can request — the host owns it
    // (ctx.workingDirectory.set); the model can only ASK, because
    // worktree_enter is a P4-gated tool (the user confirms first).
    switchSession: (target) => switchSessionFor(lastExec, target),
  };
  for (const spec of toolSpecs(helpers)) {
    const def = typeof ctx.tools?.define === "function" ? ctx.tools.define(spec) : spec;
    ctx.tools.register(def);
  }
}

export { decideToolCall };
