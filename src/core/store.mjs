// core/store.mjs — state under <git-common-dir>/worktree-guard/.
// bindings/<session>.json is THE binding truth; state.json is informational
// only (zcode lineage: state.json never produces bindings). Atomic writes.
import { mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { norm } from "./paths.mjs";

export const SCHEMA_VERSION = 1;

export function stateRoot(commonDir) {
  return join(commonDir, "worktree-guard");
}

export function bindingsDir(commonDir) {
  return join(stateRoot(commonDir), "bindings");
}

async function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// ---- bindings ----

export async function writeBinding(commonDir, sessionId, binding) {
  const file = join(bindingsDir(commonDir), `${sessionId}.json`);
  await atomicWrite(file, JSON.stringify({ ...binding, schema: SCHEMA_VERSION }, null, 2));
}

export async function readBinding(commonDir, sessionId) {
  if (!sessionId) return null;
  return readJson(join(bindingsDir(commonDir), `${sessionId}.json`));
}

export async function listBindings(commonDir) {
  const dir = bindingsDir(commonDir);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    const b = await readJson(join(dir, n));
    if (b) out.push({ sessionId: n.slice(0, -5), ...b });
  }
  return out;
}

export async function deleteBinding(commonDir, sessionId) {
  await rm(join(bindingsDir(commonDir), `${sessionId}.json`), { force: true });
}

// ---- state.json (informational + global authorize TTL carrier) ----

export async function readState(commonDir) {
  const s = (await readJson(join(stateRoot(commonDir), "state.json"))) ?? {};
  return { last_active: null, bindings_ever: 0, ...s };
}

// Per-repo mutation mutexes (round-5 M2: updateState read-modify-write could
// "resurrect" a revoked grant on interleaving; keyed per commonDir so unrelated
// repos never serialize against each other).
const stateChains = new Map(); // commonDir -> Promise (one settled entry per repo; bounded)

function serialized(commonDir, task) {
  const prev = stateChains.get(commonDir) ?? Promise.resolve();
  const p = prev.then(task);
  stateChains.set(commonDir, p.catch(() => {}));
  return p;
}

export function updateState(commonDir, patch) {
  return serialized(commonDir, async () => {
    const s = { ...(await readState(commonDir)), ...patch, updated_at: new Date().toISOString() };
    await atomicWrite(join(stateRoot(commonDir), "state.json"), JSON.stringify(s, null, 2));
    return s;
  });
}

// ---- allowlist (per-path TTL grants; model-facing write of this file is denied by guard) ----

const DANGEROUS_PATTERNS = [/^\/$/, /^\.git$/i, /^\.git\//i, /^\*$/, /^%/, /\.\./, /^\.$/];

export function validateAllowlistPath(rel) {
  if (typeof rel !== "string" || rel.trim() === "") return "path required";
  for (const re of DANGEROUS_PATTERNS) if (re.test(rel.trim())) return `dangerous pattern rejected: ${rel}`;
  return null;
}

/** readAllowlist is read-heavy; GC-on-read stays outside the mutex. */
export async function readAllowlist(commonDir) {
  const now = Date.now();
  const a = (await readJson(join(stateRoot(commonDir), "allowlist.json"))) ?? { entries: {} };
  // lazy GC of expired entries
  let changed = false;
  for (const [k, v] of Object.entries(a.entries ?? {})) {
    if (!v?.expires_at || Date.parse(v.expires_at) <= now) {
      delete a.entries[k];
      changed = true;
    }
  }
  if (changed) await atomicWrite(join(stateRoot(commonDir), "allowlist.json"), JSON.stringify(a, null, 2));
  return a;
}

/**
 * Grant ONE path/pattern. Keys are ABSOLUTE against the repo main root —
 * never process.cwd() (round-2 major fix). Relative `path` resolves under mainRoot.
 */
export function addAllowEntry(commonDir, { path, reason, ttlMinutes, grantedBy, mainRoot }) {
  return serialized(commonDir, async () => {
    const err = validateAllowlistPath(path);
    if (err) throw new Error(err);
    if (!mainRoot) throw new Error("mainRoot required: allowlist keys must be repo-absolute");
    const { isAbsolute, join: pjoin } = await import("node:path");
    const key = norm(isAbsolute(path) ? path : pjoin(mainRoot, path));
    const a = await readAllowlist(commonDir);
    a.entries = a.entries ?? {};
    const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    a.entries[key] = { reason: reason ?? "", granted_by: grantedBy ?? "user", granted_at: new Date().toISOString(), expires_at: expires };
    await atomicWrite(join(stateRoot(commonDir), "allowlist.json"), JSON.stringify(a, null, 2));
    return { path: key, expires_at: expires };
  });
}

export function clearAllowlist(commonDir) {
  return serialized(commonDir, async () => {
    await atomicWrite(join(stateRoot(commonDir), "allowlist.json"), JSON.stringify({ entries: {} }, null, 2));
  });
}

// ---- audit (jsonl convenience copy; durable copy lives in DSH session log) ----

export async function appendAudit(commonDir, entry) {
  const file = join(stateRoot(commonDir), "audit.jsonl");
  const { appendFile } = await import("node:fs/promises");
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
}

// ---- global authorize-main TTL (fail-tight: missing/expired TTL = expired, zcode lineage) ----

export function authorizeValid(state) {
  const g = state?.allow_main_writes;
  if (!g?.allow_main_writes) return null;
  const exp = Date.parse(g.allow_expires_at ?? "");
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  return g;
}

// TTL defaults live in core/constants.mjs (single source).
export { DEFAULT_AUTHORIZE_TTL_MIN, DEFAULT_ALLOW_TTL_MIN } from "./constants.mjs";
