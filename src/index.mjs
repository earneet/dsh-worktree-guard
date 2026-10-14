// index.mjs — cordis plugin entry (design §4). Assembles components:
//   A/A' guard  -> ctx.on("tools/pre-execute")   (deny/ask only, args frozen by host)
//   C    tools  -> ctx.tools.register(worktree_* specs)
//   D    notices-> session-start inject, standing line, post-execute markers
// Shape follows the dsh-tool-todo lineage: export { name, inject, Config, apply }.
// Sidecar (<repo>/.dsh/worktree-guard.json) is merged INSIDE the guard (B1 fix),
// so repo-level read_policy/protected_branches/branchPrefix reach the net.
import { decideToolCall, takePendingMark } from "./guard.mjs";
import { toolSpecs } from "./wt-tools.mjs";
import { standingLine, sessionStartText } from "./notices.mjs";
import { resolveBinding } from "./core/binding.mjs";

export const name = "worktree-guard";
export const inject = ["tools"];

export const Config = {
  enable: { type: "boolean", default: true },
  protectedBranches: { type: "array", default: ["master", "main"] },
  readPolicy: { type: "string", default: "warn" }, // warn | strict (sidecar may override)
};

export { loadSidecar as repoConfig } from "./core/sidecar.mjs";

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

  // ---- component A/A': safety net + read-domain guard (deny/ask only) ----
  ctx.on("tools/pre-execute", async (exec, next) => {
    const decision = await decideToolCall(exec, {
      protectedBranches: config.protectedBranches,
      readPolicy: config.readPolicy,
      // C9 capability probe (design §11): hosts exposing sandbox mode get the
      // danger-full-access net; absent capability degrades to no-op (P1).
      // Async-resilient: hosts whose resolve() returns a Promise still work.
      sandboxModeOf: async (header) => {
        if (typeof ctx.fs?.sandboxMode === "string") return ctx.fs.sandboxMode;
        if (typeof ctx.sandboxPolicy?.resolve === "function") {
          const resolved = await ctx.sandboxPolicy.resolve({ session: { header } });
          return resolved?.mode;
        }
        return undefined;
      },
    });
    if (decision.kind === "deny") return { kind: "deny", reason: decision.reason };
    if (decision.kind === "ask") return { kind: "ask", reason: decision.reason };
    return next({ kind: "allow" }); // markers travel via pendingMarks (P3 pipeline)
  });

  // ---- component D: markers via post-execute (read origin; P3) ----
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const mark = takePendingMark(exec?.callId);
    const out = await next();
    if (mark && out && typeof out === "object") {
      return { ...out, additionalContexts: [...(out.additionalContexts ?? []), mark] };
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
        const { commonDir } = await import("./core/gitops.mjs");
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

  // ---- component C: worktree_* tools ----
  const helpers = {
    sessionOf(exec) {
      const h = exec?.agent?.session?.header ?? {};
      return { id: h.id, cwd: h.cwd, parentSession: h.parentSession };
    },
    // sidecar is MAIN-ROOT based (a rooted session's cwd is the copy)
    config: async (cwd) => {
      const { listWorktrees } = await import("./core/gitops.mjs");
      const { loadSidecar } = await import("./core/sidecar.mjs");
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
