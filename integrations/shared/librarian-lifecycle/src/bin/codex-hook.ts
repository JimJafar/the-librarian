#!/usr/bin/env node
// Codex hook entrypoint. The thin hook scripts in integrations/codex/hooks/
// librarian/ pipe the hook event JSON to this bin on stdin. It builds the
// lifecycle from the event + environment and dispatches. It ALWAYS exits 0 and
// never blocks the prompt: the privacy guarantee is "no Librarian call", not
// "stop the model". (Codex CAN block via {"decision":"block"} / exit 2, but we
// deliberately don't.)

import { type CodexHookEvent, createCodexLifecycle, dispatchCodexHook } from "../harness/codex.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let event: CodexHookEvent = {};
  try {
    const raw = (await readStdin()).trim();
    if (raw) event = JSON.parse(raw) as CodexHookEvent;
  } catch {
    process.exit(0); // unparseable input → no state read, no call, fail closed
  }

  try {
    const lifecycle = createCodexLifecycle(event);
    dispatchCodexHook(event, lifecycle);
  } catch (err) {
    process.stderr.write(`librarian lifecycle hook error: ${(err as Error).message}\n`);
  }
  process.exit(0);
}

void main();
