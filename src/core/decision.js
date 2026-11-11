// core/decision.js — the frozen decision tables for write/read/shell calls.
// Every row maps to tests. Design doc §6. Side-effect-free functions: no fs, no
// git, no network (the one environment dependency is the module-resolved CLI
// path used in human-channel copy, see cli-path.js). All inputs are
// pre-normalized by the caller (guard.js assembles the runtime context).

import { norm, isUnder, classifyTarget, extractAbsolutePaths, extractQuotedAbsolutePaths } from "./paths.js";
import { matchesMainWhitelist } from "./sidecar.js";
import { DEFAULT_PROTECTED_BRANCHES as PROTECTED_DEFAULT, DEFAULT_BRANCH_PREFIX } from "./constants.js";
import { manualOrCliHint } from "./cli-path.js";
import { FENCE_MARKER } from "./capabilities.js";

// ---------- context assembly (caller: guard.js) ----------

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

// ---------- write/edit decision (§6 row 1) ----------

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
  // the guard's own state area is always denied: writing there could
  // self-grant permissions or tamper with audit/state (§9)
  if (isUnder(target, norm(ctx.commonDir) + "/worktree-guard")) {
    return deny("write", rawPath, "目标是 worktree-guard 状态区", "状态由 worktree_* 工具管理，不接受直接写入。");
  }
  if (cls.kind === "git-meta") {
    return deny("write", rawPath, "目标位于 .git / git 元数据", "不要写版本库元数据；如需改配置请询问用户在仓库外操作。");
  }
  // Repo security config is USER-owned (P7/P1): a model-writable sidecar could
  // empty protected_branches (disabling the push net) or whitelist itself into
  // main. Humans edit the file directly; agents use the gated tools instead.
  if (target === norm(`${ctx.mainRoot}/.dsh/worktree-guard.json`)) {
    return deny("write", rawPath, "目标是 worktree-guard 安全配置（.dsh/worktree-guard.json）", "安全配置由用户直接编辑（插件不代写）；模型侧请改用 worktree_allow / worktree_authorize_main 走人工门，或请用户手动修改。");
  }
  // cross-copy writes: ALWAYS-ON net (v0.1/zcode lineage) — checked before the
  // unbound early-return so it holds in any state (P1: stricter than host, never wider).
  if (cls.kind === "worktree" && (!binding || norm(cls.root) !== norm(binding.worktree))) {
    const next = binding
      ? `跨副本写入被禁止；本会话绑定副本 ${binding.worktree}，请用解析到本副本内的路径写入。`
      : `跨副本写入一律禁止（无论会话是否绑定）。结构隔离只能先让会话根落在该副本上——以该副本为根新开会话；在此之前"绝对路径写副本"会与${FENCE_MARKER}的沙箱冲突。`;
    return deny("write", rawPath, `目标落在${binding ? "其他" : ""}副本 ${cls.name}`, next);
  }
  if (!binding) return allow(); // P1: unbound => host sandbox semantics

  if (cls.kind === "main") {
    if (mainWriteAuthorized(target, auth)) return allow(); // user-gated grant (TTL)
    return deny("write", rawPath, "目标落在主 checkout", `本会话绑定副本 ${binding.worktree}，请用解析到本副本内的路径写入。确需写主 checkout：取得用户同意后调用 worktree_authorize_main。`);
  }
  return allow();
}

// ---------- read decision: read-domain guard (§6.1) ----------

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
    return deny("read", rawPath, "严格读域模式：目标落在主 checkout", `你在副本 ${binding.worktree} 中；请用解析到本副本内的路径读取。`);
  }
  return { kind: "allow", mark: readOriginMark(binding) };
}

/** Channel-5 marker text — single source for guard pipeline and notices. */
export function readOriginMark(binding) {
  return `[worktree-guard] 该读取来自主 checkout（非绑定副本 ${binding.worktree}）——内容是主干世界，勿据其判断副本代码现状。`;
}

// ---------- pwsh decision: lexical, always-on net (§6 row 4) ----------

// round-8: command-position separators include newline/CR (multiline scripts)
// and `(` (subexpression `$(...)` / grouping) on top of ; & |.
const CMD_SEP = "[\\n\\r;&|({]";
const RE_PUSH = new RegExp(`(^|${CMD_SEP}\\s*)git\\s+push\\b`, "i");
const RE_GIT_BRANCH = new RegExp(`(^|${CMD_SEP}\\s*)git\\s+branch\\b`, "i");
const RE_GIT_C = new RegExp(`(^|${CMD_SEP}\\s*)[gG][iI][tT]\\s+(?:-C\\s+(--\\S+|\\S+)|--git-dir(?:=|\\s+)(\\S+)|--work-tree(?:=|\\s+)(\\S+))`);

// round-8: nested executors (cmd /c, powershell/pwsh -Command, iex) and
// quote/backtick splices (`git pus""h`, `git pu\`sh`) defeated the command-
// position anchoring above. ONE normalization seam — not per-rule widening —
// folds the wrapper into a `;` separator and drops quoting/escape chars, so
// inner commands hit the SAME rules with all their token logic intact.
// Detection view only: the deny message quotes the RAW command (P3).
const RE_NESTED_EXEC =
  /(^|[\s;&|({])(?:cmd(?:\.exe)?\s+(?:\/\S+\s+)*\/c(?::|\b)|(?:powershell|pwsh)(?:\.exe)?\s+(?:-\S+\s+)*(?:-c\b|-command\b))|\b(?:iex|invoke-expression)\b/gi;

// ---------- quote-aware detection view (round-15, issue #1 residual) ----------
// The old seam stripped ALL quote characters before matching, so literal text in
// a commit message — `git commit -m "(git push origin master)"` — turned its `(`
// into a command separator and was denied. Root cause: quote stripping erased
// the distinction between CODE and quoted DATA. The view built here keeps that
// distinction:
//   - ordinary quoted content is preserved (argument-level rules still see
//     branch names / refspecs / paths) but its command separators (`(`, `;`,
//     `&`, `|`, newlines) become a non-separator placeholder;
//   - the quoted argument of an execution wrapper is CODE and is normalized
//     recursively (nested wrappers included);
//   - double-quoted content containing `$(` keeps its separators: command
//     substitution still executes there, so fail-closed;
//   - quote/backtick characters themselves are still removed, which keeps the
//     splice forms (`git pus""h`, `git pu\`sh`) normalizing to `git push`.
// `mask[i]` marks characters that came from literal quoted DATA; wrapper
// folding skips matches that touch the mask, so wrapper-looking text inside a
// commit message is not folded into a separator either.
// Honest boundary (P6): backtick command substitution inside double quotes and
// arbitrary script hosts (`node -e`, `python -c`, …) remain outside this
// lexical net; they were never promised and are unchanged by this seam.
const QUOTED_SEP = "\u0001";
const RE_SUBSTITUTION = /\$\(/;
const RE_CODE_WRAPPER_TAIL =
  /(?:^|[\n\r;&|({])\s*(?:cmd(?:\.exe)?\s+(?:\/\S+\s+)*\/c(?::|\b)|(?:powershell|pwsh)(?:\.exe)?\s+(?:-\S+\s+)*(?:-c\b|-command\b)|(?:iex|invoke-expression))\s*$/i;
// Language/shell hosts that execute their quoted argument as CODE but are not
// folded by RE_NESTED_EXEC (`bash -c`, `eval`, `node -e`, `python -c`, …).
// Their argument is recursed and the scanner prepends a separator, so a bare
// inner command still lands at a command position. Command-position anchored:
// `echo bash -c "…"` is an argument, not an execution. Common hosts are covered
// so the quote-aware view does not silently lose the old detection; exotic
// interpreters remain a P6 boundary.
const RE_SCRIPT_HOST_TAIL =
  /(?:^|[\n\r;&|({])\s*(?:(?:bash|sh|zsh|dash)(?:\.exe)?\s+(?:-\S+\s+)*-\w*c\b|\beval\b|node(?:\.exe)?\s+(?:-\S+\s+)*(?:-e|--eval|-p|--print)|(?:python|python3|py)(?:\.exe)?\s+(?:-\S+\s+)*-c|perl(?:\.exe)?\s+-[eE]|ruby(?:\.exe)?\s+-e|php(?:\.exe)?\s+-r|deno(?:\.exe)?\s+eval|bun(?:\.exe)?\s+-e)\s*$/i;

function neutralizeQuotedSeparators(s) {
  return s.replace(/[\n\r;&|({]/g, QUOTED_SEP);
}

function pushText(state, text, literal) {
  state.text += text;
  state.codeView += literal ? QUOTED_SEP.repeat(text.length) : text;
  for (let i = 0; i < text.length; i++) state.mask.push(literal);
}

/**
 * Double-quoted PowerShell/bash content: only the `$( … )` regions execute.
 * Treating the WHOLE string as code (the previous behaviour) over-denied commit
 * messages that mention a command substitution and a push in the same message.
 * Unterminated substitutions keep the remaining text as code (fail-closed).
 */
function appendSubstitutionSegments(state, content) {
  let i = 0;
  for (;;) {
    const start = content.indexOf("$(", i);
    if (start === -1) {
      pushText(state, neutralizeQuotedSeparators(content.slice(i)), true);
      return;
    }
    pushText(state, neutralizeQuotedSeparators(content.slice(i, start)), true);
    let depth = 0;
    let j = start + 1; // points at '('
    for (; j < content.length; j++) {
      const c = content[j];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) { j++; break; } }
    }
    pushText(state, content.slice(start, j), false); // substitution = code
    i = j;
  }
}

/** Append a recursively normalized view, preserving its literal-data mask. */
function appendView(state, inner) {
  state.text += inner.text;
  state.codeView += inner.codeView;
  for (let i = 0; i < inner.mask.length; i++) state.mask.push(inner.mask[i]);
}

/** Unfolded quote-aware view + literal-data mask (see the block comment above). */
function quoteAwareView(src, depth) {
  const state = { text: "", mask: [], codeView: "" };
  if (depth > 8) { pushText(state, src, false); return state; }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "`") { // PowerShell escape / line continuation
      const nx = i + 1;
      if (src[nx] === "\r" && src[nx + 1] === "\n") { pushText(state, " ", false); i = nx + 1; continue; }
      if (src[nx] === "\n" || src[nx] === "\r") { pushText(state, " ", false); i = nx; continue; }
      if (nx < src.length) pushText(state, src[nx], false);
      i = nx;
      continue;
    }
    if (ch !== "'" && ch !== '"') { pushText(state, ch, false); continue; }
    const quote = ch;
    let j = i + 1;
    let content = "";
    let closed = false;
    while (j < src.length) {
      const c = src[j];
      if (quote === '"' && c === "`") { // escaped char inside double quotes
        if (j + 1 < src.length) { content += src[j + 1]; j += 2; } else j++;
        continue;
      }
      if (c === quote) {
        if (src[j + 1] === quote) { content += quote; j += 2; continue; } // doubled quote
        closed = true;
        j++;
        break;
      }
      content += c;
      j++;
    }
    // Wrapper detection runs on codeView: an `iex` that came from quoted data
    // must not make the NEXT quoted argument look like code.
    if (RE_CODE_WRAPPER_TAIL.test(state.codeView)) {
      appendView(state, quoteAwareView(content, depth + 1));
    } else if (RE_SCRIPT_HOST_TAIL.test(state.codeView)) {
      pushText(state, ";", false); // script argument: give its first token a command position
      appendView(state, quoteAwareView(content, depth + 1));
    } else if (quote === '"' && RE_SUBSTITUTION.test(content)) {
      appendSubstitutionSegments(state, content); // only `$( … )` runs
    } else {
      pushText(state, neutralizeQuotedSeparators(content), true);
    }
    i = j - 1;
    if (!closed) break; // unterminated quote: rest is literal/parse error
  }
  return state;
}

/** Fold real wrappers; a match touching quoted data is text, not a wrapper. */
function foldWrappers(text, mask) {
  const re = new RegExp(RE_NESTED_EXEC.source, "gi");
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    let literal = false;
    for (let k = start; k < end; k++) { if (mask[k]) { literal = true; break; } }
    if (literal) continue;
    out += text.slice(last, start) + ";";
    last = end;
    if (m[0].length === 0) re.lastIndex++;
  }
  return out + text.slice(last);
}

export function normalizePwshCommand(raw) {
  const { text, mask } = quoteAwareView(String(raw ?? ""), 0);
  return foldWrappers(text, mask);
}
// checkout/switch to protected — tolerates retargeting prefix args (e.g. `git -C . checkout main`)
const RE_CHECKOUT_PROTECTED = /git\s+(?:\S+\s+)*?(?:checkout|switch)\s+(?:-\S+\s+)*(?:master|main)\b/i;
// Ask-gated tools only work where the host can show an interactive approval
// prompt. A session whose approval policy is "never" (the danger-full-access
// permission preset sets exactly that) is rejected deterministically before any
// prompt — the human-only CLI channel is then the only escape. Every copy that
// points at the gate names this fallback (round-13 live finding: the old text
// dead-ended approvals-disabled sessions).
const HUMAN_GATE_HINT = `若本会话审批提示被禁用（approval=never，常由 danger-full-access 权限预设带来）或提示被自动拒绝：不要重复调用授权工具——${manualOrCliHint()}；也可切换会弹确认的权限预设后重试。`;

// Brief form for push denies: keep the single-turn next action short; the full
// CLI path / typed-code / TTL detail lives in the gated tools' own deny+marker
// (design §7 copy budget: a 300-char conditional paragraph on every push deny
// dilutes the instruction and repeats what the tool will say anyway).
// 0.2.3 (issue #1): the brief must not pretend the ask-gated tool works in an
// approvals-disabled session — it names that dead channel explicitly instead.
const HUMAN_GATE_BRIEF = `若本会话审批提示被禁用（approval=never），worktree_authorize_main 会被宿主自动拒绝——不要重复调用：请用户手动推送/合并，或由用户在自己的交互式终端用插件 CLI 完成授权（仓库级 TTL）。`;

// ---------- push policy (0.2.3, issue #1) ----------
// An UNBOUND session rooted at the main checkout is the ordinary "work on the
// main branch and publish it" world. Publishing the CURRENT branch a human is
// already on is not a worktree copy escaping into main, so it is allowed AND
// audited (guard.js records `allow_protected_push`). Everything that can move a
// different ref, rewrite history or delete a remote ref stays denied:
//   - bound sessions (copies) never publish a protected branch;
//   - protected branches other than the current one;
//   - --force / --force-with-lease / --force-if-includes / --mirror / --delete /
//     --all / --prune, server-side command options (--receive-pack/--exec),
//     short-flag clusters carrying f/d, and `+refspec` pushes;
//   - wrapper/splice forms are judged on the normalized command (same push).
// `--dry-run` never transmits a write and is allowed in every state — denying it
// was the false positive observed live when reproducing issue #1.
const PUSH_DESTRUCTIVE_LONG = /^(?:--force(?:-with-lease|-if-includes)?|--mirror|--delete|--all|--prune|--receive-pack|--exec)\b/i;
// PowerShell fd duplication (`2>&1`, `>&2`) is NOT a command separator and has
// no operand token. Masking it before segmenting is essential: splitting on the
// `&` truncated the segment to " 2>" and made a redirected real push look like
// a bare implicit push (review finding: `git push 2>&1 origin --delete master`).
const FD_DUP_REDIRECT = /\d?>&\d+/g;
const FD_DUP_TOKEN = /^\d?>&\d+$/;

// A `git push` can be hidden behind git global options, a path-qualified
// executable, or common shell prefixes (`command`, `env`, `time`, `FOO=1`).
// The push rules run on a canonical view where those are folded away, so the
// protected-branch net cannot be bypassed by writing `git -C . push …` or
// `git.exe push …`. Options themselves are fail-closed (see rule 0c): their
// target directory may be another checkout, so the relaxed policy never applies.
const RE_GIT_GLOBAL_OPTS = String.raw`(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)(?:=|\s+)\S+\s+|--no-pager\s+|--no-optional-locks\s+|-P\s+|--paginate\s+|--bare\s+|--literal-pathspecs\s+|--glob-pathspecs\s+|--noglob-pathspecs\s+|--icase-pathspecs\s+|--no-replace-objects\s+)`;
const RE_GIT_OPTS_PUSH = new RegExp(`(^|${CMD_SEP}\\s*)[gG][iI][tT]\\s+(${RE_GIT_GLOBAL_OPTS}+)push\\b`, "g");

/** Canonical push view: fold shell prefixes / `git.exe` / git global options. */
function pushCommandView(cmd) {
  let view = cmd;
  for (let n = 0; n < 4; n++) { // prefix chains: env FOO=1 command git …
    const before = view;
    view = view
      .replace(/(^|[\n\r;&|({])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/g, "$1")
      .replace(/(^|[\n\r;&|({])\s*(?:command|env|time|exec|nohup|nice|sudo|xargs)\s+(?:-\S+\s+)*/gi, "$1");
    if (view === before) break;
  }
  view = view.replace(/(^|[\n\r;&|({])\s*(?:[A-Za-z]:[\\/][^\s;&|]*[\\/])?git(?:\.exe)?(?=\s)/gi, "$1git");
  let hasOptions = false;
  view = view.replace(RE_GIT_OPTS_PUSH, (all, pre) => {
    hasOptions = true;
    return `${pre}git push`;
  });
  return { view, hasOptions, changed: view !== cmd };
}

/** Is `-n`/`--dry-run` an actual flag (not the value of `-o`/`--push-option`)? */
function isDryRunSegment(seg) {
  const raw = seg.split(/\s+/).filter(Boolean);
  for (let i = 0; i < raw.length; i++) {
    const tk = raw[i];
    if (tk === "-o" || tk === "--push-option") { i++; continue; }
    if (tk === "-n" || tk === "--dry-run") return true;
  }
  return false;
}

/** The part of the command after the matched `git push` up to the next separator. */
function pushSegmentOf(cmd, mPush) {
  const tail = cmd.slice(mPush.index + mPush[0].length).replace(FD_DUP_REDIRECT, " ");
  return tail.split(/[\n\r;&|{]/)[0];
}

/** Flags and positional tokens of a push segment (redirect tokens dropped). */
function pushTokenView(seg) {
  const raw = seg.split(/\s+/).filter(Boolean);
  const flags = [];
  const toks = [];
  for (let i = 0; i < raw.length; i++) {
    const tk = raw[i];
    if (FD_DUP_TOKEN.test(tk)) continue; // fd duplication: no operand token
    if (tk === "-o" || tk === "--push-option") { i++; continue; } // option value is the next token
    if (tk.startsWith("--push-option=")) continue;
    if (/^[\d]*[<>]/.test(tk)) {
      // Attached file redirect (`>out.log`, `2>err.log`, `</dev/null`) — a
      // standalone `>`/`<` token consumes its operand; an attached one does not.
      if (/^[\d]*[<>]+$/.test(tk)) i++;
      continue;
    }
    if (tk.startsWith("-")) flags.push(tk);
    else toks.push(tk);
  }
  return { flags, toks };
}

function isDestructivePush(flags, refs) {
  for (const f of flags) {
    if (PUSH_DESTRUCTIVE_LONG.test(f)) return true;
    if (/^-[^-]/.test(f) && /[fd]/.test(f.slice(1))) return true; // -f, -d and clusters
  }
  return refs.some((r) => {
    if (r.startsWith("+")) return true; // forced refspec
    // `:dst` (empty source) deletes the remote ref — same intent as --delete.
    return r.replace(/^\+/, "").startsWith(":");
  });
}

/** Split one refspec into its source/destination branch names (`src:dst`; a
 *  plain name means the same name on both sides). `refs/heads/` is stripped. */
function pushRefParts(refspec) {
  const clean = refspec.replace(/^\+/, "");
  const idx = clean.indexOf(":");
  const src = (idx === -1 ? clean : clean.slice(0, idx)).replace(/^refs\/heads\//, "");
  const dst = (idx === -1 ? clean : clean.slice(idx + 1)).replace(/^refs\/heads\//, "");
  return { src, dst };
}

function isCurrentRefName(name, currentBranchName) {
  return name === currentBranchName || name === "HEAD" || name === "@";
}

/** Is the session root lexically the main checkout (copies are checked first)? */
function cwdIsMainCheckout(cwd, ctx) {
  if (!cwd) return false;
  return classifyTarget({ target: norm(cwd), mainRoot: ctx.mainRoot, worktrees: ctx.worktrees, commonDir: ctx.commonDir }).kind === "main";
}

/** Every `git push` at a command position, as its post-`push` segment. */
function allPushSegments(cmd) {
  const re = new RegExp(RE_PUSH.source, "gi");
  const segs = [];
  let m;
  while ((m = re.exec(cmd))) segs.push(pushSegmentOf(cmd, m));
  return segs;
}

/** Safe for the relaxed policy: a dry run, or a non-destructive publish that
 *  does not move a protected ref other than the current branch. */
function pushSegmentSafe(seg, currentBranchName, prot) {
  if (isDryRunSegment(seg)) return true;
  const { flags, toks } = pushTokenView(seg);
  const refs = toks.slice(1);
  if (isDestructivePush(flags, refs)) return false;
  if (refs.length === 0) return true; // implicit current-branch publish
  return refs.every((r) => {
    const { src, dst } = pushRefParts(r);
    // Updating a non-protected ref (tag / other branch) cannot touch the net.
    if (!prot.includes(dst) && dst !== "HEAD" && dst !== "@") return true;
    return isCurrentRefName(src, currentBranchName) && isCurrentRefName(dst, currentBranchName);
  });
}

/** Does this segment push the current branch (implicit, or HEAD/@ destination)? */
function segmentPushesCurrent(seg, currentBranchName) {
  const { toks } = pushTokenView(seg);
  if (/--tags\b/.test(seg) && toks.length <= 1) return false; // --tags alone cannot move a branch
  const refs = toks.slice(1);
  const effective = toks.length <= 1 ? (toks[0] ?? "") : refs.join(" ");
  const implicit = effective === ""
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(effective)
    || effective === "origin"
    || effective === "."
    || /--all\b|--mirror\b/.test(seg);
  if (implicit) return true;
  return refs.some((r) => {
    const dst = r.replace(/^\+/, "").split(":").pop();
    return dst === "HEAD" || dst === "@";
  });
}

/** Does this segment touch a protected ref (for audit semantics)? */
function segmentTouchesProtected(seg, prot) {
  const { toks } = pushTokenView(seg);
  if (/--tags\b/.test(seg) && toks.length <= 1) return false;
  const refs = toks.slice(1);
  if (refs.length === 0) return true; // implicit publish of the current protected branch
  return refs.some((r) => {
    const { dst } = pushRefParts(r);
    return prot.includes(dst) || dst === "HEAD" || dst === "@";
  });
}

/** Relaxed publish: unbound main-checkout session + protected CURRENT branch +
 *  EVERY push in the command is safe. Compound commands can no longer smuggle a
 *  force/other-branch push behind a safe first one. */
function canPublishCurrentProtected({ pushSegs, binding, cwd, ctx, currentBranchName, prot }) {
  if (binding || !currentBranchName || !prot.includes(currentBranchName) || !cwdIsMainCheckout(cwd, ctx)) return false;
  if (pushSegs.length === 0) return false;
  return pushSegs.every((seg) => pushSegmentSafe(seg, currentBranchName, prot));
}

// human-only authorization (P4): fail-closed on the literal verb in EITHER the
// raw text or the normalized (quote-stripped, wrapper-folded) view — a command
// that can produce `authorize-main` in argv must not get the benefit of the
// doubt. Round-13 (live finding) added exactly ONE narrow escape hatch: a
// command that is nothing but a chain of non-executing inspectors (doc
// read/search) may mention the verb as DATA, because denying those broke
// legitimate troubleshooting. The hatch requires every `; | &`/newline segment
// to start with an inspector and forbids launchers, scriptblocks and
// substitution — anything that can run the CLI stays denied.
//
// Why not "pin the actual invocation position" alone: the CLI's
// `process.stdin.isTTY` check is NOT structural — a launched child
// (`Start-Process`, `conhost`, python CREATE_NEW_CONSOLE, …) reports isTTY=true
// with no human present. The CLI now also requires a TYPED per-invocation code
// (wt.js → core/human-gate.js), and this net stays categorical for every verb
// sighting outside the inspector hatch.
const RE_AUTHORIZE_VERB = /\bauthorize[-_]main\b/i;
// Genuinely read-only inspectors only: writer aliases (echo/Write-Host/
// Write-Output) are deliberately absent, because the hatch's contract is
// "cannot modify anything" — the typed CLI code, not this lexical hatch, is the
// real barrier (see human-gate.js).
const READ_ONLY_INSPECTOR = /^\s*(?:Get-Content|Get-ChildItem|Get-Item|Select-String|Select-Object|Sort-Object|Measure-Object|Format-Table|Format-List|Out-String|type|cat|dir|ls|findstr|grep|rg|head|tail|wc|git\s+(?:grep|log|show|diff|status|blame|ls-files|rev-parse))\b/i;
// Flags that execute or paginate a command supplied inline (git grep -O<pager>,
// rg --pre, git --ext-diff/--textconv, file output) — an inspection becomes
// execution/writing and must not ride the hatch.
const INSPECTOR_EXEC_FLAG = /(?:^|\s)(?:--pre(?:-glob)?|--hostname-bin|--open-files-in-pager|--exec(?:=|\s)|--ext-diff|--textconv|--show-signature|--paginate|--output(?:=|\s)|-[A-Za-z]*O\S*)/i;
const READONLY_CHAIN_SEP = /[\n\r;|&]/;

/** True only for a command that is provably a pure inspector chain (see above). */
export function isReadOnlyDocInspection(rawCmd) {
  const s = String(rawCmd ?? "");
  if (/[$`{}()]/.test(s)) return false; // command substitution / subexpressions / scriptblocks
  // File redirection makes the chain a writer; `2>&1` (fd duplication) is not a
  // file write and stays allowed so ordinary `… 2>&1` searches keep working.
  if (/[<>]/.test(s.replace(FD_DUP_REDIRECT, " "))) return false;
  const code = s.replace(FD_DUP_REDIRECT, " ");
  return code.split(READONLY_CHAIN_SEP).every((seg) => {
    const t = seg.trim();
    if (t === "") return true;
    if (!READ_ONLY_INSPECTOR.test(t)) return false;
    return !INSPECTOR_EXEC_FLAG.test(t); // rg --pre / git grep -O …
  });
}

// guard state area reachable from the shell (round-3 blocker): relative .. into
// .git, or any .git/worktree-guard path — the TRAILING SEPARATOR is optional:
// round-13 audit found `cd .git/worktree-guard` + a relative write bypassed the
// old `[\/\\]`-required pattern and forged state in a throw-away repo.
// round-12 dogfood fix kept: the pattern must require the .git/ context — a bare
// "worktree-guard/" also matched THIS plugin's own repo path and denied all work.
const RE_RELATIVE_DOTGIT = /(\.\.[\/\\])+[^;&|`]*\.git\b/i;
const RE_STATE_AREA = /(?:^|[^a-z0-9_.])\.git[\/\\]worktree-guard(?=[\/\\]|\b)/i;
// guard-module imports: require OUR package context (worktree-guard/ or src/
// path segment) so user-owned store.js/guard.js are not false-positived;
// the wt.js CLI entry is netted by name (round-4 tightening).
const RE_GUARD_MODULE = new RegExp(
  [
    /(?:import|require)\s*\(?\s*["'`][^"'`]*(?:worktree-guard[\/\\]|src[\/\\])[^"'`]*(?:store|lifecycle|wt-tools|guard)\.m?js["'`]/i.source,
    /(?:import|require)\s*\(?\s*["'`](?:\.\/)?wt\.m?js["'`]/i.source,
  ].join("|"),
);

export function decidePwsh({ command, currentBranchName, cwd = null, missingPaths = null }, ctx, binding, auth = {}) {
  const rawCmd = typeof command === "string" ? command : "";
  const cmd = normalizePwshCommand(rawCmd); // round-8 detection view (see above)
  const summarizeOf = () => summarize(rawCmd);  // sanitize config: non-string entries must never crash the net into fail-open
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
  //    Fail closed on the verb in the RAW text AND in the NORMALIZED view
  //    (quote strips catch `author""ize-main`; wrapper folding catches
  //    `pwsh -Command "…"`), with ONE inspector-only escape hatch for the
  //    issue-#2 doc-search false positive. 0b below still tests the RAW text:
  //    its patterns depend on quoting shape (R4-1).
  if ((RE_AUTHORIZE_VERB.test(rawCmd) || RE_AUTHORIZE_VERB.test(cmd)) && !isReadOnlyDocInspection(rawCmd)) {
    return deny("pwsh", summarizeOf(), "试图经 shell 自授主分支写权限", `authorize-main 是人工通道；模型侧请使用 worktree_authorize_main 工具（需用户界面确认）。${HUMAN_GATE_HINT}`);
  }
  // 0b) guard state area is unreachable from the shell — write-tool rule 1's
  //     shell twin (round-3 blocker: Set-Content ../../.git/worktree-guard/...).
  if (RE_STATE_AREA.test(rawCmd) || RE_RELATIVE_DOTGIT.test(rawCmd) || RE_GUARD_MODULE.test(rawCmd)) {
    return deny("pwsh", summarizeOf(), "命令触及守卫状态区 / git 元数据 / 守卫模块", "状态由 worktree_* 工具管理；这是防自授硬规则，不可经 shell 绕过。");
  }
  // 1) push mentioning a protected ref (anywhere in the command: errs safe for a lexical net)
  const pushViewInfo = pushCommandView(cmd);
  const pushView = pushViewInfo.view;
  const mPush = pushView.match(RE_PUSH);
  const protRe = new RegExp(`\\b(?:${prot.map(esc).join("|")})\\b`, "i");
  // EVERY `git push` in a compound command is evaluated; a safe first segment
  // must not shadow a real force/delete/other-branch push later in the line.
  const pushSegs = mPush ? allPushSegments(pushView) : [];
  // 0c) git global options (`-C`, `-c`, `--git-dir`, `--no-pager`, `git.exe` …)
  // may retarget another checkout — detect the push, then fail closed.
  if (mPush && pushViewInfo.hasOptions) {
    const protectedPush = protRe.test(pushView)
      || (currentBranchName && prot.includes(currentBranchName) && pushSegs.some((seg) => segmentPushesCurrent(seg, currentBranchName)));
    if (protectedPush) {
      return deny("pwsh", summarizeOf(), "push 带 git 全局选项（-C / -c / --git-dir / --no-pager 等），无法静态判定其目标仓库", `请在目标仓库目录直接执行 git push（不要用全局选项改道），或由用户授权/手动推送。${HUMAN_GATE_BRIEF}`);
    }
  }
  // 0d) runtime refspec (`$var`, `("mas"+"ter")`, scriptblocks) cannot be
  // resolved lexically — fail closed instead of letting an expression build a
  // protected branch name at runtime.
  if (mPush) {
    const dynamicPush = pushSegs.some((seg) => {
      const { flags, toks } = pushTokenView(seg);
      return toks.slice(1).some((r) => /[$({}`]/.test(r)) || flags.some((f) => /[$({}`]/.test(f));
    });
    if (dynamicPush) {
      return deny("pwsh", summarizeOf(), "push 的 refspec/选项含运行时表达式或变量，无法静态判定目标分支", `请改用字面 refspec（如 origin master），或由用户授权/手动推送。${HUMAN_GATE_BRIEF}`);
    }
  }
  if (mPush && protRe.test(pushView) && authorized) return allow(); // user-gated grant (TTL)
  const onlyDryRun = pushSegs.length > 0 && pushSegs.every((seg) => isDryRunSegment(seg));
  const canPublish = canPublishCurrentProtected({ pushSegs, binding, cwd, ctx, currentBranchName, prot });
  const relaxedPush = onlyDryRun || canPublish;
  if (mPush && protRe.test(pushView) && !relaxedPush) {
    // round-8/copy review: a push only visible after normalization (quote splice
    // or wrapper) gets its OWN effect-oriented reason — generic text makes the
    // model assume a false positive and retry with another wrapper. Wording
    // names no detection dimension (P6 copy rule: effects, not mechanisms).
    if (!pushViewInfo.changed && !RE_PUSH.test(rawCmd)) {
      return deny("pwsh", summarizeOf(), "该命令经拼接或包装后仍会将提交推送到受保护分支；包装形式不改变拦截结果", `如确需推送受保护分支，取得用户同意后调用 worktree_authorize_main（TTL 授权后可执行等效 git 命令）。${HUMAN_GATE_BRIEF}`);
    }
    if (binding) {
      return deny("pwsh", summarizeOf(), `push 目标包含受保护分支（${prot.join("/")}）`, `本会话绑定副本 ${binding.worktree}：只能推送本副本的 worktree 分支；合并回主干走收尾授权流程。${HUMAN_GATE_BRIEF}`);
    }
    if (!currentBranchName || !prot.includes(currentBranchName)) {
      return deny("pwsh", summarizeOf(), `push 目标包含受保护分支（${prot.join("/")}），但当前不在该分支`, `在主 checkout 上只放行"推送当前分支"（当前：${currentBranchName ?? "未知"}）；请先切换到目标分支，或由用户授权/手动推送。${HUMAN_GATE_BRIEF}`);
    }
    return deny("pwsh", summarizeOf(), `该 push 的目标不是当前分支，或带有强制/删除/全量等破坏性选项（受保护分支 ${prot.join("/")}）`, `主 checkout 上只放行"推送当前分支（${currentBranchName}）"；请去掉 --force/--force-with-lease/--delete/--all/--mirror 等选项并确认 refspec 指向当前分支后重试。${HUMAN_GATE_BRIEF}`);
  }
  // 1b) push DELETING a worktree branch (remote deletion, round-2 fix) — only the
  //     destructive forms (`--delete`/`-d`, or `:branch` refspec); pushing own branch stays open.
  const colonRe = new RegExp(`:${String(ctx.branchPrefix ?? DEFAULT_BRANCH_PREFIX).toLowerCase()}[\\w.-]+`, "i");
  if (mPush && !authorized && (/--delete\b/i.test(cmd) || colonRe.test(cmd))) {
    const tokens = cmd.split(/[\s;&|]+/).map((t) => t.replace(/^:/, ""));
    if (tokens.some((t) => worktreeBranchToken(t))) {
      return deny("pwsh", summarizeOf(), "远程删除 worktree 分支", "分支删除由收尾流程在本地执行（仅删已合并分支）。");
    }
  }
  // 2) implicit `git push` while ON a protected branch (zcode lineage).
  //    round-12 usability fix: only pushes that can move the current branch are
  //    netted — `git push origin v0.2.0` (a tag) or `git push origin worktree-x`
  //    cannot touch master and must stay open. HEAD/@ destinations still net.
  if (mPush && currentBranchName && prot.includes(currentBranchName)) {
    const pushesCurrent = pushSegs.some((seg) => segmentPushesCurrent(seg, currentBranchName));
    if (!authorized && !relaxedPush && pushesCurrent) {
      return deny("pwsh", summarizeOf(), `当前处于受保护分支 ${currentBranchName}，该 push 会推送主干`, `裸 push/HEAD 推送受保护分支只在"未绑定且根在主 checkout"时放行；破坏性选项仍被拦截，其他情况请指定显式 refspec 或由用户授权。${HUMAN_GATE_BRIEF}`);
    }
  }
  // 3) any `git branch` command touching a worktree branch token — decoy-first
  //    multi-branch deletes (`git branch -d decoy worktree-x`) and equals-form
  //    flags all fall out of token scanning (round-2 fix). Read-only queries
  //    (`--list`, `--contains`, …) are not lifecycle mutations and stay open.
  const readOnlyBranchQuery = /(?:^|\s)(?:--list|-l|--contains|--merged|--no-merged|--show-current|--points-at)(?=\s|$)/i.test(cmd)
    && !/(?:^|\s)-[dDmMcC]\b/.test(cmd);
  if (RE_GIT_BRANCH.test(cmd) && !readOnlyBranchQuery) {
    const tokens = cmd.split(/[\s;&|]+/).map((t) => t.replace(/^[*+]/, ""));
    if (tokens.some((t) => worktreeBranchToken(t))) {
      return deny("pwsh", summarizeOf(), "git branch 命令涉及 worktree 分支", "worktree 分支的创建/删除由 worktree_* 工具统一管理（仅删已合并分支）。");
    }
  }
  // 4) git retargeting flags: absolute targets classified; RELATIVE `..`-escapes
  //    denied while bound — cwd is the copy, so ANY `..` hop leaves it (round-2: also
  //    `sub/../../..` forms; `.` alone is fine but the checkout rule below still nets it).
  const mC = RE_GIT_C.exec(cmd);
  if (mC) {
    const target = mC[2] ?? mC[3] ?? mC[4];
    // A relative / --git-dir target that is gone gets the same GONE diagnostic
    // as an absolute one (issue #2: `git -C .worktrees/gone` used to be allowed).
    if (typeof target === "string" && !target.startsWith("--")) {
      const absTarget = norm(target, cwd || ctx.mainRoot);
      if (absTarget && missingPaths?.has(absTarget)) {
        return deny("pwsh", summarizeOf(), "git 定向参数指向一个已不存在的路径", `该路径可能曾是 worktree 副本且已被清理（${clipPath(absTarget)}）；先调用 worktree_status 盘点绑定，必要时 worktree_prune 回收过期绑定，请勿再引用该路径。`);
      }
    }
    if (binding && typeof target === "string" && !target.startsWith("--") && /(^|[\\/])\.\.([\\/]|$)/.test(target)) {
      return deny("pwsh", summarizeOf(), "git 定向参数以 .. 逃出副本", `本会话绑定副本 ${binding.worktree}；请在副本目录内直接执行 git 命令。`);
    }
    for (const p of pathCandidates(rawCmd, cmd, mC.index)) {
      const cls = classifyTarget({ target: norm(p), mainRoot: ctx.mainRoot, worktrees: ctx.worktrees, commonDir: ctx.commonDir });
      // issue #2: a deleted copy root is lexically inside mainRoot but is not a
      // registered worktree anymore, so classifyTarget calls it "main". Say the
      // path is GONE instead of asserting the user pointed at the main checkout;
      // otherwise the "next step" (cd into it) fails with ENOENT and misleads.
      if (cls.kind === "main" && missingPaths?.has(norm(p))) {
        return deny("pwsh", summarizeOf(), "git 定向参数指向主 checkout 内一个已不存在的路径", `该路径可能曾是 worktree 副本且已被清理（${clipPath(p)}）；先调用 worktree_status 盘点绑定，必要时 worktree_prune 回收过期绑定，请勿再引用该路径。`);
      }
      if (cls.kind === "main" || (cls.kind === "worktree" && binding && norm(cls.root) !== norm(binding.worktree)) || cls.kind === "git-meta") {
        return deny("pwsh", summarizeOf(), `git 定向参数指向 ${cls.kind === "main" ? "主 checkout" : cls.kind === "git-meta" ? ".git 元数据" : `其他副本 ${cls.name ?? ""}`}`, `本会话${binding ? `绑定副本 ${binding.worktree}，` : ""}请在目标副本目录内直接执行 git 命令。`);
      }
    }
  }
  // 5) checkout/switch to a protected branch while bound (compound + retargeted forms)
  if (binding && protRe.test(cmd) && RE_CHECKOUT_PROTECTED.test(cmd) && !authorized) {
    return deny("pwsh", summarizeOf(), "切换到受保护分支", `本会话绑定副本 ${binding.worktree}；收尾合并走授权流程，不要直接切主干。`);
  }
  // 6) residual absolute paths into main / git-meta while bound (lexical net; last resort)
  if (binding) {
    for (const p of pathCandidates(rawCmd, cmd, 0)) {
      const cls = classifyTarget({ target: norm(p), mainRoot: ctx.mainRoot, worktrees: ctx.worktrees, commonDir: ctx.commonDir });
      if (cls.kind === "main" || cls.kind === "git-meta") {
        return deny("pwsh", summarizeOf(), `命令包含${cls.kind === "main" ? "主 checkout " : ".git 元数据 "}绝对路径`, `本会话绑定副本 ${binding.worktree}；请改用解析到本副本内的路径（cwd 已是副本），或用 write/edit 工具写文件。`);
      }
    }
  }
  // The relaxed push path reaches this point only after rules 1b–6 also ran, so
  // a compound command cannot hide a branch delete / retarget / checkout behind
  // a safe push. Audit only when a real (non-dry-run) push touched a protected
  // ref — a plain push of an unprotected feature branch is not a deviation.
  const auditPush = canPublish && !onlyDryRun && pushSegs.some((seg) => segmentTouchesProtected(seg, prot));
  return auditPush ? allow({ audit: "allow_protected_push" }) : allow();
}

// ---------- shared ----------

function allow(extra) {
  return extra ? { kind: "allow", ...extra } : { kind: "allow" };
}

function clipPath(p) {
  const s = String(p);
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}

/**
 * Absolute-path candidates for one command: the token-level extractor plus the
 * full quoted literals. A token-level match that was truncated at a space inside
 * a quoted path (`git -C "F:/repo dir"` → `F:/repo`) is dropped when a quoted
 * literal continues it, so the complete path decides the domain.
 */
function pathCandidates(rawCmd, cmd, fromIndex) {
  const quoted = extractQuotedAbsolutePaths(rawCmd);
  const quotedNorm = quoted.map((q) => norm(q));
  const plain = extractAbsolutePaths(cmd.slice(fromIndex)).filter((p) => {
    const np = norm(p);
    return !quotedNorm.some((qp) => qp.length > np.length && qp.startsWith(np) && /[\/\\ ]/.test(qp[np.length]));
  });
  return [...plain, ...quoted];
}

/**
 * Raw targets of `git -C` / `--git-dir` / `--work-tree` options (issue #2).
 * Lexical only; the caller resolves them and feeds `missingPaths` so this
 * module keeps its no-fs contract.
 */
export function extractGitRetargets(command) {
  const out = [];
  const re = new RegExp(RE_GIT_C.source, "g");
  let m;
  while ((m = re.exec(command))) {
    const t = m[2] ?? m[3] ?? m[4];
    if (typeof t === "string" && !t.startsWith("--")) out.push(t.replace(/^["']|["']$/g, ""));
  }
  return out;
}

function deny(tool, subject, reason, next) {
  // Every deny message is three-part (channel 4): what / why / next
  // single-turn action — the message itself is the last line of defense (§7).
  return {
    kind: "deny",
    reason: `[worktree-guard] 已阻止 ${tool}：${subject}。\n原因：${reason}。\n下一步：${next}`,
  };
}

function summarize(rawCmd) {
  const one = String(rawCmd).replace(/\s+/g, " ").trim();
  return one.length > 60 ? one.slice(0, 57) + "..." : one;
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { PROTECTED_DEFAULT };

