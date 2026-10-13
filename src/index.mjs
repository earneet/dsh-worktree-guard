// index.mjs — cordis plugin entry (design §4). Assembles components:
//   A/A' guard  -> ctx.on("tools/pre-execute")
//   C    tools  -> ctx.tools.register(defineTool-like specs)
//   D    notices-> session-start inject, standing line, post-execute markers
// Shape follows the dsh-tool-todo lineage: export { name, inject, Config, apply }.
// defineTool is injected at apply time (host bundle may not be importable here);
// we degrade gracefully to a plain spec registration (zero-dependency core).
import { decideToolCall, takePendingMark } from "./guard.mjs";
import { toolSpecs } from "./wt-tools.mjs";
import { standingLine, sessionStartText, readOriginMark, PREFIX } from "./notices.mjs";
import { resolveBinding, isRooted } from "./core/binding.mjs";
import { commonDir } from "./core/gitops.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const name = "worktree-guard";
export const inject = ["tools"];

export const Config = {
  enable: { type: "boolean", default: true },
  protectedBranches: { type: "array", default: ["master", "main"] },
  readPolicy: { type: "string", default: "warn" }, // warn | strict
  failOpenReads: { type: "boolean", default: true },
};

/** Sidecar config: <repo>/.dsh/worktree-guard.json (P7: DSH config space). */
export async function repoConfig(cwd) {
  try {
    const text = await readFile(join(cwd, ".dsh", "worktree-guard.json"), "utf8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function apply(ctx, config) {
  if (config.enable === false) return;

  const optsOf = (cwd) => ({
    protectedBranches: config.protectedBranches,
    readPolicy: config.readPolicy,
  });

  // ---- component A/A': safety net + read-domain guard (deny/ask only) ----
  ctx.on("tools/pre-execute", async (exec, next) => {
    const opts = optsOf(exec?.agent?.session?.header?.cwd);
    const decision = await decideToolCall(exec, opts);
    if (decision.kind === "deny") return { kind: "deny", reason: decision.reason };
    if (decision.kind === "ask") return { kind: "ask", reason: decision.reason };
    return next(decision.kind === "allow" && decision.mark ? { kind: "allow" } : decision);
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

  // ---- component D: session-start inject (channel 3) ----
  ctx.on("agent/session-start", async (agent, next) => {
    const text = await sessionStartText({
      cwd: agent?.session?.header?.cwd,
      sessionId: agent?.session?.header?.id,
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
    config: repoConfig,
  };
  for (const spec of toolSpecs(helpers)) {
    const def = typeof ctx.tools?.define === "function" ? ctx.tools.define(spec) : spec;
    ctx.tools.register(def);
  }
}

export { decideToolCall };
