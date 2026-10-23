// Platform-portable fixture world. The guard is Windows-first, so fixtures are
// written as Windows drive literals; on posix hosts map the drive to a valid
// absolute root so isAbsolute/resolve behave. All containment relationships
// (main / copies-nested-under-main / common dir) are preserved either way.
import { IS_WIN } from "../../src/core/paths.js";

export { IS_WIN };
export const P = (p) => (IS_WIN ? p : "/" + p.replace(/\\/g, "/").replace(/^([a-zA-Z]):/, "$1"));

export const MAIN = P("F:/repo");
export const WT_A = P("F:/repo/.worktrees/worktree-alpha");
export const WT_B = P("F:/repo/.worktrees/worktree-beta");
export const COMMON = P("F:/repo/.git");
