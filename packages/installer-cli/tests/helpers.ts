// Test helpers: a throwaway HOME dir so nothing touches the real
// `~/.librarian`. Every test gets its own temp dir, removed after.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run `fn` with a fresh temp home dir, cleaned up afterwards. */
export async function withTempHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-cli-test-"));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
