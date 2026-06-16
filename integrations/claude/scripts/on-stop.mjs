#!/usr/bin/env node
// Claude `Stop` / `SessionEnd` hook entry — the THIN shell over the testable pure
// logic in scripts/lib/. Spec 2026-06-16-harness-auto-capture, T3 + PART A.
//
// Wiring (integrations/claude/hooks/hooks.json): the marketplace install (`/plugin
// install`) auto-discovers a plugin's `hooks/hooks.json`; BOTH the `Stop` and the
// `SessionEnd` entries run `node ${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.mjs`. `Stop`
// fires per turn-end (the incremental ingestion clock); `SessionEnd` fires on a
// true session end (close / `/clear`) and is the explicit-end accelerator —
// `runCapture`'s `isSessionEnd()` reads `hook_event_name` to set `ended:true` so
// the server settle-sweep extracts immediately instead of waiting out the idle
// window (spec §4.4). Claude delivers the hook JSON on STDIN (`transcript_path`,
// `session_id`, `cwd`, `hook_event_name`, and `agent_id` for a subagent Stop). We
// read it, hand it to `runCapture`, and ALWAYS `exit 0`.
//
// FAIL-SOFT CONTRACT (AGENTS.md / SC10): this process must never block the user's
// turn, never exit non-zero in a way that breaks Claude, never leak a stack trace
// to stdout/stderr that reaches the model. So: no output on the happy path, errors
// go to the local sidecar (capture.log) only, and we exit 0 unconditionally —
// even on a parse failure or an unhandled rejection. On uncertainty, do nothing.

import process from "node:process";
import { runCapture } from "./lib/capture.mjs";

/**
 * Read all of stdin (the hook JSON) as a string. Resolves "" if there is none.
 *
 * FAIL-SOFT / NO-HANG (I2): fail-soft must never depend on the harness closing
 * the pipe. A held-open stdin (no `end` event) would otherwise hang this process
 * until the harness's own timeout. We resolve on `end`/`error` as normal, but ALSO
 * arm a short internal timeout that resolves with whatever we have so far (usually
 * `""`) so the entry can fail-soft no-op and exit promptly instead of stalling the
 * user's turn.
 */
function readStdin(timeoutMs = 2500) {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    // `unref` so a still-open stdin can't keep the event loop alive past our work.
    const timer = setTimeout(() => finish(data), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => finish(data));
    process.stdin.on("error", () => finish(data));
  });
}

async function main() {
  const raw = await readStdin();
  let hook;
  try {
    hook = raw ? JSON.parse(raw) : {};
  } catch {
    // Malformed hook JSON — nothing safe to do. Exit 0 (fail-soft).
    return;
  }
  // runCapture is itself fully fail-soft; we still guard the call so even an
  // unexpected throw never escapes as a non-zero exit / stack trace.
  try {
    await runCapture(hook, process.env);
  } catch {
    // Swallowed — runCapture already logs to the sidecar on known paths.
  }
}

main()
  .catch(() => {
    // Absolute backstop: never propagate.
  })
  .finally(() => {
    process.exit(0);
  });
