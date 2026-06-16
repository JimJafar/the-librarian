#!/usr/bin/env node
// Claude `Stop` hook entry — the THIN shell over the testable pure logic in
// scripts/lib/. Spec 2026-06-16-harness-auto-capture, T3.
//
// Wiring (integrations/claude/hooks/hooks.json): the marketplace install (`/plugin
// install`) auto-discovers a plugin's `hooks/hooks.json`; our `Stop` entry runs
// `node ${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.mjs`. Claude delivers the hook JSON
// on STDIN (`transcript_path`, `session_id`, `cwd`, and `agent_id` for a
// subagent Stop). We read it, hand it to `runCapture`, and ALWAYS `exit 0`.
//
// FAIL-SOFT CONTRACT (AGENTS.md / SC10): this process must never block the user's
// turn, never exit non-zero in a way that breaks Claude, never leak a stack trace
// to stdout/stderr that reaches the model. So: no output on the happy path, errors
// go to the local sidecar (capture.log) only, and we exit 0 unconditionally —
// even on a parse failure or an unhandled rejection. On uncertainty, do nothing.

import process from "node:process";
import { runCapture } from "./lib/capture.mjs";

/** Read all of stdin (the hook JSON) as a string. Resolves "" if there is none. */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
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
