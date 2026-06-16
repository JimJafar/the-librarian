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
