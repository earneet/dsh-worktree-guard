// cli-path.js — absolute path of the human CLI entry derived from THIS module's
// location (wt.js, or wt.mjs in the pre-rename layout). The CLI file ships in
// the plugin package, NOT in the user's repo, so copy that says a bare
// `node wt.js …` dead-ends for profile-installed plugins (the user's cwd is the
// target repo). Embedding the resolved path keeps the deny/ask "next step"
// single-turn executable (P6 copy rule).
import { fileURLToPath } from "node:url";

const here = import.meta.url;
const ext = here.endsWith(".mjs") ? "mjs" : "js";
export const CLI_PATH = (() => {
  try {
    // this module lives in <pkg>/src/core/, the CLI at <pkg>/wt.js
    return fileURLToPath(new URL(`../../wt.${ext}`, here));
  } catch {
    return `wt.${ext}`;
  }
})();

/** Command form: the CLI resolves the repo from its CWD, so it must run INSIDE
 *  the target repository. */
export function cliCommand(reason = "<原因>") {
  return `node "${CLI_PATH}" authorize-main "${reason}"`;
}

/** Human-channel sentence for deny/ask/marker copy. The typed confirmation is
 *  named because a console can be created programmatically with isTTY=true. */
export function humanChannelHint() {
  return `请用户在其交互式终端、目标仓库目录运行本插件 CLI：${cliCommand()}（会要求输入终端显示的随机确认码；仓库级 TTL，对本仓库所有会话生效）`;
}

/** The shared "do not retry, go human" clause (manual push/merge + CLI). Kept
 *  in ONE place so deny/ask copy cannot drift between decision.js and guard.js. */
export function manualOrCliHint() {
  return `请用户手动推送/合并，或改用人工通道：${humanChannelHint()}`;
}
