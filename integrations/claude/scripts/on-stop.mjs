#!/usr/bin/env node
// Claude capture hook entry — the THIN shell over the testable pure logic in
// scripts/lib/. Spec 2026-06-16-harness-auto-capture, T3 + PART A.
//
// Wiring (integrations/claude/hooks/hooks.json): the marketplace install (`/plugin
// install`) auto-discovers a plugin's `hooks/hooks.json`; the `UserPromptSubmit`,
// `Stop`, and `SessionEnd` entries ALL run `node ${CLAUDE_PLUGIN_ROOT}/scripts/
// on-stop.mjs`. The same entry serves every trigger; `runCapture` is event-agnostic
// (it reads the cursor delta from `transcript_path` and ships it), so no per-event
// branching is needed beyond `isSessionEnd()`.
//
//   - `UserPromptSubmit` is the PRIMARY trigger. Claude Code bug #29767 means
//     plugin-scoped `Stop` hooks register but never fire (a `SessionStart` from the
//     same plugin DOES fire), so a `Stop`-only adapter would never run.
//     `UserPromptSubmit` fires reliably — just before the assistant reply — so it
//     ingests up to the PREVIOUS completed turn (one turn behind; per spec §8.2 that
//     is fine — incremental ingestion loses at most the last un-acked turn anyway,
//     and the next prompt catches it up). Its payload carries the same
//     `session_id` + `transcript_path` + `cwd` a `Stop` would.
//   - `Stop` / `SessionEnd` are SUPPLEMENTARY / self-healing. They stay wired so the
//     moment Anthropic fixes #29767 they resume firing and contribute for free; the
//     cursor's advance-on-ack makes multiple firing events idempotent (a re-read
//     delta the server/curator dedup). `SessionEnd` is additionally the explicit-end
//     accelerator — `runCapture`'s `isSessionEnd()` reads `hook_event_name` to set
//     `ended:true` so the server settle-sweep extracts immediately instead of waiting
//     out the idle window (spec §4.4). `UserPromptSubmit` and `Stop` never set
//     `ended`.
//
// KNOWN TRADEOFF (deferred optimization): the ship is SYNCHRONOUS, so a slow or
// unreachable server adds latency to the user's prompt up to the hook timeout (15s
// for `UserPromptSubmit`) before failing soft. This is bounded and fail-soft — the
// turn always proceeds — but backgrounding the ship (fire-and-forget) so the prompt
// never waits is a deferred optimization, not yet done.
//
// Claude delivers the hook JSON on STDIN (`transcript_path`, `session_id`, `cwd`,
// `hook_event_name`, and `agent_id` for a subagent Stop). We read it, hand it to
// `runCapture`, and ALWAYS `exit 0`.
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
