#!/usr/bin/env node
// `librarian` CLI bin entrypoint.
//
// Runs the typed runtime over the caller's argv, prints the captured
// stdout/stderr, and translates the structured result into a process exit
// code. The runtime is pure over `{ home }`, so tests drive it directly
// without spawning this process.

import { runCli } from "./runtime.js";

const result = runCli(process.argv.slice(2));
if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exitCode = result.exitCode || 0;
