// human-gate.js — the CLI's typed confirmation challenge (P4, runtime level).
//
// The CLI's `process.stdin.isTTY` check is NOT structural: a model can create a
// console programmatically (`Start-Process`, `conhost`, python with
// CREATE_NEW_CONSOLE, …) and the child then reports isTTY=true with no human
// present. Requiring a typed PER-INVOCATION code turns that into a timeout
// instead of a grant, because the code is only shown on that terminal.
//
// Honest level (P6): this is a mechanically checked CHALLENGE-RESPONSE, not a
// structural boundary and not identity proof. A program that can read the
// console buffer and inject keyboard input (pty/ConPTY, AttachConsole +
// ReadConsoleOutput + WriteConsoleInput) can replay it — but such arbitrary
// code execution already permits writing the state file directly (§14.3). The
// structural human gate remains the host ask gate; this channel raises the bar
// for everything short of arbitrary code execution.

/**
 * Wait for the operator to type `phrase` (case-insensitive) on an interactive
 * stream. Resolves true only on an exact match; false on mismatch, EOF or
 * timeout (default 60 s) — never leaves a grant behind. `phrase` is REQUIRED:
 * a fixed/empty default would let a launched console confirm itself.
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, phrase: string, timeoutMs?: number}} opts
 * @returns {Promise<boolean>}
 */
export function confirmTyped({ input = process.stdin, output = process.stdout, phrase, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    if (typeof phrase !== "string" || phrase.trim() === "") { resolve(false); return; }
    let buf = "";
    let settled = false;
    const expect = phrase.trim().toUpperCase();
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { input.off?.("data", onData); } catch { /* stream already gone */ }
      try { input.off?.("end", onEnd); } catch { /* stream already gone */ }
      try { input.off?.("error", onError); } catch { /* stream already gone */ }
      try { input.pause?.(); } catch { /* stream already gone */ }
      resolve(ok);
    };
    const onData = (chunk) => {
      buf += String(chunk);
      const nl = buf.search(/[\r\n]/);
      if (nl !== -1) finish(buf.slice(0, nl).trim().toUpperCase() === expect);
      else if (buf.length > 64) finish(false); // pasted garbage, not a confirmation
    };
    const onEnd = () => finish(false);
    const onError = () => finish(false); // destroyed/errored stdin must fail closed, not crash
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    try {
      output.write(`输入 ${phrase} 确认（${Math.max(1, Math.round(timeoutMs / 1000))} 秒内）：`);
      input.setEncoding?.("utf8");
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onError);
      input.resume?.();
    } catch {
      finish(false);
    }
  });
}
