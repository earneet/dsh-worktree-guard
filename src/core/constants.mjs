// core/constants.mjs — single source for tunables (round-5 review: hardcoded
// duplicates in decision/lifecycle/store/wt-tools were drifting apart).

export const DEFAULT_BRANCH_PREFIX = "worktree-";
export const DEFAULT_WORKTREE_PARENT = ".worktrees";
export const DEFAULT_PROTECTED_BRANCHES = ["master", "main"];

export const DEFAULT_AUTHORIZE_TTL_MIN = 15;
export const DEFAULT_ALLOW_TTL_MIN = 60;
export const AUTHORIZE_TTL_CAP_MIN = 240;
export const ALLOW_TTL_CAP_MIN = 480;

/** A session (or state record) silent past this is stale / prunable. */
export const STALE_THRESHOLD_MS = 24 * 3600_000;

/** Guard context cache TTL (ms) — see guard.mjs. */
export const GUARD_CTX_TTL_MS = 2_000;

/** Cap for per-session bookkeeping sets (standing-line injection memory). */
export const SESSION_SET_CAP = 1000;
