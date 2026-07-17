#!/usr/bin/env node
// Codex capture hook entry — the THIN shell over the testable pure logic in
// scripts/lib/. Spec 2026-06-16-harness-auto-capture, Phase 2A. Mirrors the Claude
// entry (integrations/claude/scripts/on-stop.mjs); Codex fires the SAME
// command-hook events, so the same entry serves every trigger.
//
// Wiring (integrations/codex/hooks/codex-hooks.json, merged into ~/.codex/hooks.json
// by the installer): the `UserPromptSubmit`, `Stop`, and `SessionEnd` entries ALL
// run `node ${LIBRARIAN_CODEX_ROOT}/scripts/on-stop.mjs`. `runCapture` is
// event-agnostic (it reads the cursor delta from `transcript_path` and ships it),
// so no per-event branching is needed beyond the `SessionEnd` accelerator that
// runCapture reads off `hook_event_name`.
//
//   - `UserPromptSubmit` is the PRIMARY trigger, mirroring Claude (bug #29767 made
//     plugin-scoped `Stop` hooks unreliable there; using UserPromptSubmit as the
//     primary keeps the two adapters identical and robust). It fires just before
//     the assistant reply, so it ingests up to the PREVIOUS completed turn (one
//     turn behind; spec §8.2 tolerates this — the next prompt catches it up).
//   - `Stop` / `SessionEnd` are SUPPLEMENTARY. The cursor's advance-on-ack makes
//     multiple firing events idempotent. `SessionEnd` is the explicit-end
//     accelerator (runCapture sets `ended:true`) so the server settle-sweep
//     extracts immediately instead of waiting out the idle window.
//
// Codex 0.144.3 live capture confirmed JSON on STDIN carrying the stable session
// id and rollout transcript path used by runCapture. We read the documented hook
// fields, hand them to runCapture, and ALWAYS exit 0; future shape changes fail
// soft and leave an unrecognized transcript cursor in place for a newer adapter.
//
// FAIL-SOFT CONTRACT (AGENTS.md): this process must never block the user's turn,
// never exit non-zero, never leak a stack trace that reaches the model. So: no
// output on the happy path, errors go to the local sidecar (capture.log) only, and
// we exit 0 unconditionally — even on a parse failure or an unhandled rejection.

import process from "node:process";
import { runCapture } from "./lib/capture.mjs";

/**
 * Read all of stdin (the hook JSON) as a string. Resolves "" if there is none.
 *
 * NO-HANG: fail-soft must never depend on the harness closing the pipe. A
 * held-open stdin would otherwise hang this process until the harness's own
 * timeout. We resolve on `end`/`error`, but ALSO arm a short internal timeout that
 * resolves with whatever we have so far so the entry can fail-soft no-op promptly.
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
