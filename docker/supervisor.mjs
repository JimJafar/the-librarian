#!/usr/bin/env node
// Process supervisor for the single-container image (spec: deploy-single-container, C1).
//
// Runs as PID 1 and starts both services as children (the MCP HTTP server and the
// Next.js dashboard). Its only jobs are the two things a container's init must get
// right:
//
//   1. Signal forwarding — relay SIGTERM/SIGINT to both children so each runs its
//      own graceful shutdown, then exit 0 once both are down.
//   2. Crash-fast — if either child exits while we are NOT shutting down, kill the
//      sibling and exit non-zero, so the orchestrator restarts the whole pair
//      rather than leaving the container half-up.
//
// Zero dependencies (shipped verbatim in the image; no build step). The two child
// commands come from LIBRARIAN_SUPERVISOR_CHILDREN (JSON `[{name,cmd,args}]`) so the
// Dockerfile owns the real image paths and tests can inject fakes.

import { spawn } from "node:child_process";

function loadChildren() {
  const raw = process.env.LIBRARIAN_SUPERVISOR_CHILDREN;
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("LIBRARIAN_SUPERVISOR_CHILDREN must be a non-empty JSON array");
    }
    return parsed;
  }
  // Fallback for the all-in-one image (the Dockerfile sets the env explicitly).
  return [
    { name: "mcp-server", cmd: process.execPath, args: ["mcp-server/dist/bin/http.js"] },
    { name: "dashboard", cmd: process.execPath, args: ["dashboard/server.js"] },
  ];
}

const children = loadChildren();

// "running" → all up; "signal" → graceful shutdown from a received signal (exit 0);
// "crash" → a child died unexpectedly (exit non-zero).
let mode = "running";
let crashCode = 1;

const procs = children.map((child) =>
  spawn(child.cmd, child.args ?? [], { stdio: "inherit", env: process.env }),
);

function alive(proc) {
  return proc.exitCode === null && proc.signalCode === null;
}

function stopAll(signal) {
  for (const proc of procs) {
    if (alive(proc)) proc.kill(signal);
  }
}

function finishIfAllDown() {
  if (procs.some(alive)) return;
  process.exit(mode === "crash" ? crashCode : 0);
}

for (const proc of procs) {
  proc.on("error", () => {
    // Failed to spawn (e.g. bad path) is an unexpected death → crash-fast.
    if (mode === "running") {
      mode = "crash";
      crashCode = 1;
      stopAll("SIGTERM");
    }
    finishIfAllDown();
  });
  proc.on("exit", (code) => {
    if (mode === "running") {
      // A child exiting on its own — even with code 0 — means the container can no
      // longer do its job. Take everything down and report failure.
      mode = "crash";
      crashCode = code && code !== 0 ? code : 1;
      stopAll("SIGTERM");
    }
    finishIfAllDown();
  });
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (mode === "running") mode = "signal";
    stopAll(signal);
  });
}
