// run-tests.mjs — npm test entry.
// Windows Git for Windows ships `core.fsmonitor=true` in its SYSTEM config. With
// many throw-away repos created in parallel, `git worktree add` can deadlock
// against the fsmonitor daemon (observed on this host: the child hung at
// `git reset --hard --no-recurse-submodules`; `git add` hung the same way).
// The tests own every repo they touch, so disable the daemon for their git
// children only — the user's git config is never modified.
//
// The glob is expanded here (simple `*`/`?` in a basename) because the package
// declares Node >=20, while `node --test <glob>` only understands globs from
// Node 21+.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const args = process.argv.slice(2).length ? process.argv.slice(2) : ["test/*.test.js"];

function expandGlob(arg) {
  if (!/[*?]/.test(arg)) return [arg];
  const dir = dirname(arg);
  const re = new RegExp(
    "^" + basename(arg).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => re.test(n)).map((n) => join(dir, n));
}

const files = args.flatMap(expandGlob);
if (files.length === 0) {
  console.error(`run-tests: no test files matched ${args.join(" ")}`);
  process.exit(1);
}

const env = { ...process.env };
// Append instead of clobbering a caller-supplied GIT_CONFIG_* block.
const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
env.GIT_CONFIG_COUNT = String(existing + 1);
env[`GIT_CONFIG_KEY_${existing}`] = "core.fsmonitor";
env[`GIT_CONFIG_VALUE_${existing}`] = "false";

const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit", env });
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : code ?? 1);
});
