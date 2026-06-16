#!/usr/bin/env node
// Claude `PreToolUse` (Write|Edit|MultiEdit) hook entry — the THIN shell over the
// pure classifier in scripts/lib/memory-write-guard.mjs. Spec
// 2026-06-16-harness-auto-capture, T4 (SC8); ADR 0009 layer 3.
//
// Wiring (integrations/claude/hooks/hooks.json): a `PreToolUse` entry with matcher
// `Write|Edit|MultiEdit` runs `node ${CLAUDE_PLUGIN_ROOT}/scripts/block-memory-
// write.mjs`. Claude delivers the hook JSON on STDIN (`tool_name`, `tool_input`
// with `file_path`/`path`). We read it, ask the classifier, and:
//   - native Claude memory store write → BLOCK: print the teaching message to
//     STDERR and `exit 2`. Claude treats a PreToolUse exit 2 as "deny this tool
//     call" and shows the stderr to the AGENT — which is exactly the redirect-to-
//     `remember` teaching we want.
//   - anything else → ALLOW: `exit 0`, no output.
//
// FAIL-OPEN CONTRACT (spec §4.8, AGENTS.md fail-soft): a guard bug must NEVER
// block a legitimate write. So ANY error on this path — malformed stdin, a throw,
// an unhandled rejection — exits 0 (allow). Only a CONFIDENT native-store match
// exits 2. We never leak a stack trace; the only stderr we ever emit is the
// deliberate teaching message on a confident block.

import process from "node:process";
import { evaluateMemoryWrite } from "./lib/memory-write-guard.mjs";

/**
 * Read all of stdin (the hook JSON) as a string. Resolves "" if there is none.
 *
 * FAIL-OPEN / NO-HANG (I2): fail-open must never depend on the harness closing the
 * pipe. A held-open stdin (no `end` event) would otherwise hang here until the
 * harness's own timeout — and a write-block hook that times out could be read as a
 * DENY, the exact opposite of the fail-OPEN contract. We resolve on `end`/`error`
 * as normal, but ALSO arm a short internal timeout that resolves with whatever we
 * have (usually `""` → malformed/empty → allow, exit 0) so a legitimate write is
 * never blocked by a stuck read.
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
    // Malformed hook JSON — fail OPEN (allow). Exit 0.
    return 0;
  }

  let verdict;
  try {
    verdict = evaluateMemoryWrite(hook);
  } catch {
    // The classifier is itself fail-open, but guard the call too: any throw → allow.
    return 0;
  }

  if (verdict && verdict.block) {
    // Block: teaching message to STDERR, exit 2 (Claude denies the tool call and
    // shows the stderr to the agent).
    process.stderr.write(`${verdict.message}\n`);
    return 2;
  }
  return 0;
}

main()
  .then((code) => process.exit(typeof code === "number" ? code : 0))
  .catch(() => {
    // Absolute backstop: any unhandled error fails OPEN (allow).
    process.exit(0);
  });
