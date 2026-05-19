#!/usr/bin/env node
import { LibrarianStore } from "@librarian/core";
import { runCli } from "./cli.js";

const store = new LibrarianStore();
try {
  const result = runCli(process.argv.slice(2), store);
  if (result.stdout) console.log(result.stdout);
  process.exitCode = result.exitCode || 0;
} finally {
  store.close();
}
