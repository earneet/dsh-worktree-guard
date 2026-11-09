// run-tests.mjs — npm test entry.
// Windows Git for Windows ships `core.fsmonitor=true` in its SYSTEM config. With
// many throw-away repos created in parallel, `git worktree add` can deadlock
// against the fsmonitor daemon (observed on this host: the child hung at
// `git reset --hard --no-recurse-submodules`; `git add` hung the same way).
// The tests own every repo they touch, so disable the daemon for their git
// children only — the user's git config is never modified.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const env = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
};
const child = spawn(process.execPath, ["--test", ...args], { stdio: "inherit", env });
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : code ?? 1);
});
