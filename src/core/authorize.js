// core/authorize.js — the single grant/revoke path for protected-main
// authorization. Both human channels land here (the ask-gated
// `worktree_authorize_main` tool and the interactive CLI), so TTL clamping,
// state shape, and audit cannot drift apart. The human proof is INJECTED as
// `confirm`: the tool passes a constant-true callback (its ask gate already
// blocked for user confirmation upstream), while the CLI passes a typed
// per-invocation code prompt. That keeps the grant testable without a real
// console and makes "never write a grant before confirmation" a property of
// ONE code path (round-13).
import { updateState, appendAudit } from "./store.js";
import { DEFAULT_AUTHORIZE_TTL_MIN, AUTHORIZE_TTL_CAP_MIN } from "./constants.js";

/**
 * Clamp a requested authorize TTL into the supported window (1..CAP minutes);
 * falsy/invalid requests fall back to the default. Shared with the CLI so the
 * pre-confirmation banner shows the SAME duration that will be granted.
 */
export function clampAuthorizeTtl(ttlMinutes) {
  return Math.max(1, Math.min(Number(ttlMinutes) || DEFAULT_AUTHORIZE_TTL_MIN, AUTHORIZE_TTL_CAP_MIN));
}

/**
 * @param {object} opts
 * @param {string} opts.commonDir repo git-common-dir (state root)
 * @param {string} [opts.reason] audited reason
 * @param {number|string} [opts.ttlMinutes] requested TTL (clamped: 1..CAP)
 * @param {string} [opts.by] grant provenance ("user-ask-gate" | "cli-human")
 * @param {string} [opts.session] requesting session id (audit)
 * @param {() => Promise<boolean>} opts.confirm human proof; false => NO state write
 * @returns {Promise<{authorized:boolean, ttlMinutes:number, expiresAt?:string}>}
 */
export async function authorizeMain({ commonDir, reason = "", ttlMinutes, by = "cli-human", session, confirm = async () => false }) {
  const ttl = clampAuthorizeTtl(ttlMinutes);
  if (!(await confirm())) return { authorized: false, ttlMinutes: ttl };
  const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
  const st = await updateState(commonDir, {
    allow_main_writes: {
      allow_main_writes: true,
      allow_reason: reason,
      allow_at: new Date().toISOString(),
      allow_expires_at: expiresAt,
      allow_by: by,
    },
  });
  await appendAudit(commonDir, { type: "authorize_main", by, ...(session ? { session } : {}), reason, ttl_minutes: ttl });
  return { authorized: true, ttlMinutes: ttl, expiresAt: st.allow_main_writes.allow_expires_at };
}

/** Revoke the repo-wide authorize TTL (same single path as the grant). */
export async function revokeMain({ commonDir, by = "cli-human", session }) {
  await updateState(commonDir, { allow_main_writes: {} });
  await appendAudit(commonDir, { type: "revoke_main", by, ...(session ? { session } : {}) });
}
