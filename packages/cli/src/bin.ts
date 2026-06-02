#!/usr/bin/env node
// CLI bin entrypoint.
//
// Builds the store from the caller's environment, runs the typed
// runtime, prints the captured stdout, and translates the structured
// result into a process exit code.

import { createLibrarianStore, resolveBackend } from "@librarian/core";
import { runCli } from "./runtime.js";

const store = createLibrarianStore({ backend: resolveBackend() });
try {
  const result = runCli(process.argv.slice(2), store);
  if (result.stdout) console.log(result.stdout);
  process.exitCode = result.exitCode || 0;
} finally {
  // `restore` closes the store itself before replacing the SQLite file, so guard
  // against a double close here.
  try {
    store.close();
  } catch {
    // already closed
  }
}
