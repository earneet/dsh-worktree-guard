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
import { decideToolCall, takePendingMark, gateRejectionMark, isGatedTool } from "./guard.js";
import { toolSpecs } from "./wt-tools.js";
import { standingLine, sessionStartText } from "./notices.js";
import { resolveBinding } from "./core/binding.js";

export const name = "worktree-guard";
export const inject = ["tools"];

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

  // ---- component A/A': safety net + read-domain guard (deny/ask only) ----
  ctx.on("tools/pre-execute", async (exec, next) => {
    const decision = await decideToolCall(exec, {
      protectedBranches: config.protectedBranches,
      readPolicy: config.readPolicy,
      // Sandbox-mode capability probe (C9): when the host exposes the current
      // sandbox mode, a bound session in danger-full-access gets the extra
      // deny net; without the capability this degrades to a no-op (P1).
      // Design §11. Async-resilient: hosts whose resolve() returns a Promise
      // still work.
      sandboxModeOf: async (header) => {
        if (typeof ctx.fs?.sandboxMode === "string") return ctx.fs.sandboxMode;
        if (typeof ctx.sandboxPolicy?.resolve === "function") {
          const resolved = await ctx.sandboxPolicy.resolve({ session: { header } });
          return resolved?.mode;
        }
        return undefined;
      },
      approvalPolicyOf: effectiveApprovalPolicy,
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
    const out = await next();
    const extra = [mark, gateMark].filter(Boolean);
    if (extra.length && out && typeof out === "object") {
      return { ...out, additionalContexts: [...(out.additionalContexts ?? []), ...extra] };
    }
    return out;
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
    const text = await sessionStartText({
      cwd: agent?.session?.header?.cwd,
      sessionId: agent?.session?.header?.id,
      parentSession: agent?.session?.header?.parentSession ?? null,
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
  };
  for (const spec of toolSpecs(helpers)) {
    const def = typeof ctx.tools?.define === "function" ? ctx.tools.define(spec) : spec;
    ctx.tools.register(def);
  }
}

export { decideToolCall };
