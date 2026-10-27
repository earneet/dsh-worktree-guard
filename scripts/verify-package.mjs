// scripts/verify-package.mjs — release gate: pack the npm tarball, extract it,
// and prove the PUBLISHED layout works. This exists because the round-13 audit
// found a bug class that unit tests could not catch: the CLI path embedded in
// deny copy resolved to `<pkg>/src/wt.js` (nonexistent) from the source tree and
// every test compared it against the same constant. A packaging smoke must run
// the shipped files, in the shipped layout.
//
// No network: `npm pack` is local and the tarball is extracted with the OS tar
// (bsdtar on Windows 10+/GitHub runners).
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fail = (msg) => { throw new Error(`package smoke: ${msg}`); };
const check = (cond, msg) => { if (!cond) fail(msg); };

/** Run the local npm CLI without shell quoting (args are never escaped). */
function npmInvocation() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return [process.execPath, [process.env.npm_execpath]];
  }
  const candidate = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(candidate)) return [process.execPath, [candidate]];
  return null;
}

function npmPack(dest) {
  const args = ["pack", "--json", "--pack-destination", dest];
  const inv = npmInvocation();
  try {
    if (inv) return execFileSync(inv[0], [...inv[1], ...args], { cwd: ROOT, encoding: "utf8" });
    return execFileSync("npm", args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  } catch (err) {
    fail(`npm pack failed: ${String(err?.stderr ?? err?.message ?? err)}`);
  }
}

async function main() {
  const rootPkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const work = await mkdtemp(join(tmpdir(), "wtg-package-"));
  const extractDir = join(work, "extract");
  try {
    const stdout = npmPack(work);
    const packed = JSON.parse(stdout);
    check(Array.isArray(packed) && packed.length === 1, "npm pack did not report exactly one tarball");
    const filenames = packed[0].files.map((f) => f.path);
    // The tarball ships sources only: tests, docs, scripts and dev junk must not leak.
    for (const forbidden of ["test/", "doc/", "scripts/", "node_modules/", ".github/", "examples/"]) {
      check(!filenames.some((p) => p.startsWith(forbidden)), `tarball leaks ${forbidden}`);
    }
    for (const required of [
      "package.json", "wt.js", "cordis.patch.yml", "README.md", "LICENSE",
      "src/index.js", "src/guard.js", "src/wt-tools.js", "src/notices.js",
      "src/core/decision.js", "src/core/authorize.js", "src/core/cli-path.js",
      "src/core/human-gate.js", "src/core/store.js",
    ]) {
      check(filenames.includes(required), `tarball is missing ${required}`);
    }
    check(filenames.length >= 15 && filenames.length <= 25, `unexpected tarball file count: ${filenames.length}`);

    const tgz = join(work, packed[0].filename);
    // Extract: the OS tar ships with Windows 10+/GitHub runners and Ubuntu.
    execFileSync("tar", ["-xzf", tgz, "-C", work], { stdio: "ignore" });
    const pkgDir = join(work, "package");
    const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));
    check(pkg.name === rootPkg.name, `name mismatch: ${pkg.name}`);
    check(pkg.version === rootPkg.version, `version mismatch: ${pkg.version} != ${rootPkg.version}`);
    check(pkg.bin?.wt === "wt.js", `bin.wt must point at wt.js, got ${JSON.stringify(pkg.bin)}`);
    check(pkg.main === "src/index.js", `main must be src/index.js, got ${pkg.main}`);
    check(pkg.dsh?.bundle?.patch === "cordis.patch.yml", "dsh.bundle.patch missing");

    // The shipped CLI must run from the extracted package (no node_modules needed).
    const help = execFileSync(process.execPath, [join(pkgDir, "wt.js"), "help"], { encoding: "utf8" });
    check(/dsh-worktree-guard CLI/.test(help), "packaged wt.js help output is unexpected");

    // THE regression this gate exists for: the CLI path used by deny/ask copy
    // must resolve to the real, shipped wt.js from the INSTALLED layout.
    const { CLI_PATH } = await import(pathToFileURL(join(pkgDir, "src/core/cli-path.js")).href);
    check(resolve(CLI_PATH) === resolve(join(pkgDir, "wt.js")), `installed CLI_PATH wrong: ${CLI_PATH}`);
    await access(CLI_PATH); // throws if the shipped file is missing

    // Non-TTY authorize-main must refuse before writing any state (structural
    // half of the human channel; the typed-code half needs a real console).
    const repo = join(work, "repo");
    execFileSync("git", ["init", "-b", "main", repo], { cwd: work, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "smoke@test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "smoke"], { cwd: repo });
    const refused = (() => {
      try {
        execFileSync(process.execPath, [join(pkgDir, "wt.js"), "authorize-main", "package-smoke"], {
          cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        });
        return null;
      } catch (err) {
        return err;
      }
    })();
    check(refused?.status === 1, "non-TTY authorize-main must exit 1");
    check(/人工通道/.test(String(refused.stderr ?? "")), "non-TTY refusal message missing");
    await access(join(repo, ".git")); // repo intact
    const stateFile = join(repo, ".git", "worktree-guard", "state.json");
    check(!(await access(stateFile).then(() => true, () => false)), "non-TTY authorize-main wrote state");

    console.log(`package smoke OK: ${pkg.name}@${pkg.version}, ${filenames.length} files, CLI + CLI_PATH + non-TTY gate verified`);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
