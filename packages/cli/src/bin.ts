#!/usr/bin/env node
// CLI bin entrypoint.
//
// Builds the store from the caller's environment, runs the typed
// runtime, prints the captured stdout, and translates the structured
// result into a process exit code.

import { runCli } from "./runtime.js";
import { createCliStore } from "./store.js";

// Keyed store (env → <dataDir>/secret.key) so admin verbs can decrypt secret
// settings — e.g. the dashboard-saved backup token `restore` needs. See store.ts.
const store = createCliStore();
try {
  // Top-level await: the runtime is async since spec 073 T1 (`refs add <url>`
  // fetches). The `finally` below still runs after the await settles, so the
  // store is closed on both the success and the throw path exactly as before.
  const result = await runCli(process.argv.slice(2), store);
  if (result.stdout) console.log(result.stdout);
  process.exitCode = result.exitCode || 0;
} finally {
  // Defensive: a command may already have closed the store, so guard against a
  // double close here.
  try {
    store.close();
  } catch {
    // already closed
  }
}
