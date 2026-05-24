#!/usr/bin/env node
// Claude Code hook entrypoint. The thin shell hook scripts in
// integrations/claude-code/hooks/librarian/ pipe the hook event JSON to this
// bin on stdin. It builds the lifecycle from the event + environment and
// dispatches. It ALWAYS exits 0 and never blocks the prompt: the privacy
// guarantee is "no Librarian call", not "stop the model".

import {
  type ClaudeHookEvent,
  createClaudeCodeLifecycle,
  dispatchClaudeHook,
} from "../harness/claude-code.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let event: ClaudeHookEvent = {};
  try {
    const raw = (await readStdin()).trim();
    if (raw) event = JSON.parse(raw) as ClaudeHookEvent;
  } catch {
    // Unparseable hook input → do nothing. No state read, no Librarian call:
    // fail closed for the turn.
    process.exit(0);
  }

  try {
    const lifecycle = createClaudeCodeLifecycle(event);
    dispatchClaudeHook(event, lifecycle);
  } catch (err) {
    // The lifecycle handlers already swallow their own state/CLI errors; this
    // catches only unexpected failures. Never block the user (§9) — log to
    // stderr (transcript-only) and exit 0.
    process.stderr.write(`librarian lifecycle hook error: ${(err as Error).message}\n`);
  }
  process.exit(0);
}

void main();
