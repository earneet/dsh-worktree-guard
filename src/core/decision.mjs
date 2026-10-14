// core/decision.mjs — frozen decision tables (design §6). Every row maps to tests.
// Pure functions: no fs, no git. All inputs are pre-normalized by the caller
// (guard.mjs assembles the runtime context).

import { norm, isUnder, classifyTarget, extractAbsolutePaths } from "./paths.mjs";
import { matchesMainWhitelist } from "./sidecar.mjs";
import { DEFAULT_PROTECTED_BRANCHES as PROTECTED_DEFAULT, DEFAULT_BRANCH_PREFIX } from "./constants.mjs";

// ---------- context assembly (caller: guard.mjs) ----------

/**
 * Build the guard context for one repo from live git data (caller supplies).
 * { mainRoot, commonDir, worktrees: [{root,name}], protectedBranches, branchPrefix }
 */
export function makeContext({ mainRoot, commonDir, worktrees = [], protectedBranches = PROTECTED_DEFAULT, branchPrefix = DEFAULT_BRANCH_PREFIX }) {
  return {
    mainRoot: norm(mainRoot),
    commonDir: norm(commonDir),
    worktrees: worktrees.map((w) => ({ root: norm(w.root), name: w.name })),
    protectedBranches,
    branchPrefix,
  };
}

// ---------- authorization state (P4 gate output consumed here) ----------
// { authorize: <authorizeValid(state) result or null>, allowlist: {normPath: entry},
//   whitelist: [sidecar main_write_whitelist patterns] }
// P1 note: these lift GUARD rules only — the host sandbox still applies structurally.

function mainWriteAuthorized(target, auth) {
  if (auth?.authorize) return true; // user passed the ask gate (TTL still valid)
  if (auth?.whitelist?.length && matchesMainWhitelist(target, auth.whitelist)) return true;
  if (auth?.allowlist) {
    const t = norm(target);
    // exact file or directory-prefix match against granted entries
    for (const key of Object.keys(auth.allowlist)) {
      if (t === key || t.startsWith(key.endsWith("/") ? key : key + "/")) return true;
    }
  }
  return false;
}

// ---------- write/edit decision (design §6 row 1) ----------

/**
 * @param {string} rawPath model-supplied file_path
 * @param {string} baseDir resolution base (session cwd)
 * @param {object} ctx guard context
 * @param {{worktree:string}|null} binding
 * @param {object} [auth] authorization state (see above)
 */
export function decideWrite(rawPath, baseDir, ctx, binding, auth = {}) {
  const target = norm(rawPath, baseDir);
  if (!target) return deny("write", rawPath, "空路径", "提供有效的相对或绝对路径。");

  const cls = classifyTarget({ target, mainRoot: ctx.mainRoot, worktrees: ctx.worktrees, commonDir: ctx.commonDir });
  // state area is always denied (self-grant / tamper protection, design §9)
  if (isUnder(target, norm(ctx.commonDir) + "/worktree-guard")) {
    return deny("write", rawPath, "目标是 worktree-guard 状态区", "状态由 worktree_* 工具管理，不接受直接写入。");
  }
  if (cls.kind === "git-meta") {
    return deny("write", rawPath, "目标位于 .git / git 元数据", "不要写版本库元数据；如需改配置请询问用户在仓库外操作。");
  }
  // cross-copy writes: ALWAYS-ON net (v0.1/zcode lineage) — checked before the
  // unbound early-return so it holds in any state (P1: stricter than host, never wider).
  if (cls.kind === "worktree" && (!binding || norm(cls.root) !== norm(binding.worktree))) {
    return deny("write", rawPath, `目标落在${binding ? "其他" : ""}副本 ${cls.name}`, `跨副本写入被禁止；本会话${binding ? `绑定 ${binding.worktree}` : "未绑定"}。请写主 checkout（未绑定时）或本会话绑定的副本。`);
  }
  if (!binding) return allow(); // P1: unbound => host sandbox semantics

  if (cls.kind === "main") {
    if (mainWriteAuthorized(target, auth)) return allow(); // user-gated grant (TTL)
    return deny("write", rawPath, "目标落在主 checkout", `本会话绑定副本 ${binding.worktree}；请用相对路径写入本副本。写主 checkout 需用户授权：经用户同意后调用 worktree_authorize_main。`);
  }
  return allow();
}

// ---------- read decision (design §6.1 read-domain guard) ----------

/**
 * warn (default): allow + mark origin when reading main while bound.
 * strict: deny main reads; other worktrees / .git reads stay open (troubleshooting).
 */
export function decideRead(rawPath, baseDir, ctx, binding, { readPolicy = "warn" } = {}) {
  if (!binding) return allow();
  const target = norm(rawPath, baseDir);
  if (!target) return allow();
  const cls = classifyTarget({ target, mainRoot: ctx.mainRoot, worktrees: ctx.worktrees, commonDir: ctx.commonDir });
  if (cls.kind !== "main") return allow();
  if (readPolicy === "strict") {
    return deny("read", rawPath, "严格读域模式：目标落在主 checkout", `你在副本 ${binding.worktree} 中；请用相对路径读取本副本。`);
  }
  return { kind: "allow", mark: readOriginMark(binding) };
}

/** Channel-5 marker text — single source for guard pipeline and notices. */
export function readOriginMark(binding) {
  return `[worktree-guard] 该读取来自主 checkout（非绑定副本 ${binding.worktree}）——内容是主干世界，勿据其判断副本代码现状。`;
}

// ---------- pwsh decision (design §6 row 4; lexical, always-on net) ----------

const RE_PUSH = /(^|[;&|]\s*)git\s+push\b/i;
const RE_GIT_BRANCH = /(^|[;&|]\s*)git\s+branch\b/i;
const RE_GIT_C = /(^|[;&|]\s*)git\s+(?:-C\s+(--\S+|\S+)|--git-dir(?:=|\s+)(\S+)|--work-tree(?:=|\s+)(\S+))/i;
// checkout/switch to protected — tolerates retargeting prefix args (e.g. `git -C . checkout main`)
const RE_CHECKOUT_PROTECTED = /git\s+(?:\S+\s+)*?(?:checkout|switch)\s+(?:-\S+\s+)*(?:master|main)\b/i;
// human-only authorization (P4): the model must NEVER say authorize-main in a
// shell — the only sanctioned path is the ask-gated worktree_authorize_main tool.
// (Humans use their own terminal, which does not pass this net; rename-the-CLI
// variants fall out because we key on the verb, not the file name.)
const RE_AUTHORIZE_VERB = /\bauthorize[-_]main\b/i;
// guard state area reachable from the shell (round-3 blocker): relative .. into
// .git, any worktree-guard path mention, or direct import of guard modules.
const RE_RELATIVE_DOTGIT = /(\.\.[\/\\])+[^;&|`]*\.git\b/i;
const RE_STATE_AREA = /worktree-guard[\/\\]/i;
// guard-module imports: require OUR package context (worktree-guard/ or src/
// path segment) so user-owned store.mjs/guard.mjs are not false-positived;
// the wt.mjs CLI entry is netted by name (round-4 tightening).
const RE_GUARD_MODULE = new RegExp(
  [
    /(?:import|require)\s*\(?\s*["'`][^"'`]*(?:worktree-guard[\/\\]|src[\/\\])[^"'`]*(?:store|lifecycle|wt-tools|guard)\.mjs["'`]/i.source,
    /(?:import|require)\s*\(?\s*["'`](?:\.\/)?wt\.mjs["'`]/i.source,
  ].join("|"),
);

export function decidePwsh({ command, currentBranchName }, ctx, binding, auth = {}) {
  const cmd = typeof command === "string" ? command : "";
  // sanitize config: non-string entries must never crash the net into fail-open
  const protectedList = (Array.isArray(ctx.protectedBranches) ? ctx.protectedBranches : [])
    .filter((s) => typeof s === "string" && s.trim() !== "");
  const prot = protectedList.length ? protectedList : PROTECTED_DEFAULT;
  const authorized = !!auth?.authorize;
  const worktreeBranchToken = (t) => {
    const prefix = String(ctx.branchPrefix ?? DEFAULT_BRANCH_PREFIX).toLowerCase();
    return t.toLowerCase().startsWith(prefix) || (binding && t.replace(/^[*+]/, "") === binding.branch);
  };

  // 0) human-only authorization channels: the model must never reach authorize
  //    semantics through a shell, whatever the entry point (round-2/3 blockers).
  if (RE_AUTHORIZE_VERB.test(cmd)) {
    return deny("pwsh", summarize(cmd), "试图经 shell 自授主分支写权限", "authorize-main 是人工通道；模型侧请使用 worktree_authorize_main 工具（需用户界面确认）。");
  }
  // 0b) guard state area is unreachable from the shell — write-tool rule 1's
  //     shell twin (round-3 blocker: Set-Content ../../.git/worktree-guard/...).
  if (RE_STATE_AREA.test(cmd) || RE_RELATIVE_DOTGIT.test(cmd) || RE_GUARD_MODULE.test(cmd)) {
    return deny("pwsh", summarize(cmd), "命令触及守卫状态区 / git 元数据 / 守卫模块", "状态由 worktree_* 工具管理；这是防自授硬规则，不可经 shell 绕过。");
  }
  // 1) push mentioning a protected ref (anywhere in the command: errs safe for a lexical net)
  const mPush = cmd.match(RE_PUSH);
  const protRe = new RegExp(`\\b(?:${prot.map(esc).join("|")})\\b`, "i");
  if (mPush && protRe.test(cmd)) {
    if (authorized) return allow(); // user-gated grant (TTL)
    return deny("pwsh", summarize(cmd), `push 目标包含受保护分支（${prot.join("/")}）`, "合并回主干需用户授权：经用户同意后调用 worktree_authorize_main（TTL 自动失效）。");
  }
  // 1b) push DELETING a worktree branch (remote deletion, round-2 fix) — only the
  //     destructive forms (`--delete`/`-d`, or `:branch` refspec); pushing own branch stays open.
  const colonRe = new RegExp(`:${String(ctx.branchPrefix ?? DEFAULT_BRANCH_PREFIX).toLowerCase()}[\\w.-]+`, "i");
  if (mPush && !authorized && (/--delete\b/i.test(cmd) || colonRe.test(cmd))) {
    const tokens = cmd.split(/[\s;&|]+/).map((t) => t.replace(/^:/, ""));
    if (tokens.some((t) => worktreeBranchToken(t))) {
      return deny("pwsh", summarize(cmd), "远程删除 worktree 分支", "分支删除由收尾流程在本地执行（仅删已合并分支）。");
    }
  }
  // 2) bare `git push` while ON a protected branch (zcode lineage)
  if (mPush && currentBranchName && prot.includes(currentBranchName)) {
    if (!authorized) {
      return deny("pwsh", summarize(cmd), `当前处于受保护分支 ${currentBranchName}，裸 push 等同推送主干`, "请显式指定目标分支，或走授权流程。");
    }
  }
  // 3) any `git branch` command touching a worktree branch token — decoy-first
  //    multi-branch deletes (`git branch -d decoy worktree-x`) and equals-form
  //    flags all fall out of token scanning (round-2 fix).
  if (RE_GIT_BRANCH.test(cmd)) {
    const tokens = cmd.split(/[\s;&|]+/).map((t) => t.replace(/^[*+]/, ""));
    if (tokens.some((t) => worktreeBranchToken(t))) {
      return deny("pwsh", summarize(cmd), "git branch 命令涉及 worktree 分支", "worktree 分支的创建/删除由 worktree_* 工具统一管理（仅删已合并分支）。");
    }
  }
  // 4) git retargeting flags: absolute targets classified; RELATIVE `..`-escapes
  //    denied while bound — cwd is the copy, so ANY `..` hop leaves it (round-2: also
  //    `sub/../../..` forms; `.` alone is fine but the checkout rule below still nets it).
  const mC = RE_GIT_C.exec(cmd);
  if (mC) {
    const target = mC[2] ?? mC[3] ?? mC[4];
    if (binding && typeof target === "string" && !target.startsWith("--") && /(^|[\\/])\.\.([\\/]|$)/.test(target)) {
      return deny("pwsh", summarize(cmd), "git 定向参数以 .. 逃出副本", `本会话绑定副本 ${binding.worktree}；请在副本目录内直接执行 git 命令。`);
    }
    for (const p of extractAbsolutePaths(cmd.slice(mC.index))) {
      const cls = classifyTarget({ target: norm(p), mainRoot: ctx.mainRoot, worktrees: ctx.worktrees, commonDir: ctx.commonDir });
      if (cls.kind === "main" || (cls.kind === "worktree" && binding && norm(cls.root) !== norm(binding.worktree)) || cls.kind === "git-meta") {
        return deny("pwsh", summarize(cmd), `git 定向参数指向 ${cls.kind === "main" ? "主 checkout" : cls.kind === "git-meta" ? ".git 元数据" : `其他副本 ${cls.name ?? ""}`}`, `本会话${binding ? `绑定副本 ${binding.worktree}，` : ""}请在目标副本目录内直接执行 git 命令。`);
      }
    }
  }
  // 5) checkout/switch to a protected branch while bound (compound + retargeted forms)
  if (binding && protRe.test(cmd) && RE_CHECKOUT_PROTECTED.test(cmd) && !authorized) {
    return deny("pwsh", summarize(cmd), "切换到受保护分支", `本会话绑定副本 ${binding.worktree}；收尾合并走授权流程，不要直接切主干。`);
  }
  // 6) residual absolute paths into main / git-meta while bound (lexical net; last resort)
  if (binding) {
    for (const p of extractAbsolutePaths(cmd)) {
      const cls = classifyTarget({ target: norm(p), mainRoot: ctx.mainRoot, worktrees: ctx.worktrees, commonDir: ctx.commonDir });
      if (cls.kind === "main" || cls.kind === "git-meta") {
        return deny("pwsh", summarize(cmd), `命令包含${cls.kind === "main" ? "主 checkout " : ".git 元数据 "}绝对路径`, `本会话绑定副本 ${binding.worktree}；请改用相对路径（cwd 已是副本），或用 write/edit 工具写文件。`);
      }
    }
  }
  return allow();
}

// ---------- shared ----------

function allow() {
  return { kind: "allow" };
}

function deny(tool, subject, reason, next) {
  // Three-part contract (design §7 channel 4): what / why / next single-turn action.
  return {
    kind: "deny",
    reason: `[worktree-guard] 已阻止 ${tool}：${subject}。\n原因：${reason}。\n下一步：${next}`,
  };
}

function summarize(cmd) {
  const one = String(cmd).replace(/\s+/g, " ").trim();
  return one.length > 60 ? one.slice(0, 57) + "..." : one;
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { PROTECTED_DEFAULT };
