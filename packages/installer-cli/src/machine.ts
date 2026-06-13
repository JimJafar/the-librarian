// Machine identity for the dashboard's Installs view.
//
// Each machine gets a stable UUID, generated on first run and stored
// at `~/.librarian/machine-id`. It's the dashboard's row key (Phase 2),
// so two identical setups on different machines stay distinct. The
// hostname rides along for human-readable display.
//
// The `home` argument is injectable for tests — pass a temp dir to keep
// the real `~/.librarian/machine-id` untouched.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { librarianDir, machineIdPath } from "./paths.js";

/**
 * Read the machine id, generating and persisting one on first call.
 *
 * Stable across calls: once written, the same UUID is returned forever.
 * A blank/whitespace-only file is treated as missing and regenerated.
 */
export function machineId(home?: string): string {
  const idPath = machineIdPath(home);
  try {
    const existing = fs.readFileSync(idPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // not yet written — fall through and create it
  }
  const id = randomUUID();
  fs.mkdirSync(librarianDir(home), { recursive: true });
  fs.writeFileSync(idPath, `${id}\n`, { encoding: "utf8" });
  return id;
}

/** The machine's hostname, for human-readable dashboard display. */
export function hostname(): string {
  return os.hostname();
}
