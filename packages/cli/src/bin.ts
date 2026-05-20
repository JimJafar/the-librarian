#!/usr/bin/env node
// CLI bin entrypoint.
//
// Builds the store from the caller's environment, runs the typed
// runtime, prints the captured stdout, and translates the structured
// result into a process exit code.

import { createLibrarianStore } from "@librarian/core";
import { runCli } from "./runtime.js";

const store = createLibrarianStore();
try {
  const result = runCli(process.argv.slice(2), store);
  if (result.stdout) console.log(result.stdout);
  process.exitCode = result.exitCode || 0;
} finally {
  store.close();
}
