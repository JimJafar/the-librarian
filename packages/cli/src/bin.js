#!/usr/bin/env node
import { createLibrarianStore } from "@librarian/core";
import { runCli } from "./cli.js";

const store = createLibrarianStore();
try {
  const result = runCli(process.argv.slice(2), store);
  if (result.stdout) console.log(result.stdout);
  process.exitCode = result.exitCode || 0;
} finally {
  store.close();
}
