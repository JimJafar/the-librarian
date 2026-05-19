// Typed JSONL helpers for The Librarian's append-only event ledgers.
//
// `readJsonl` parses every non-empty line of the file (returning `[]` for a
// missing file). `appendJsonl` writes a single entry followed by a newline.
// Neither helper performs schema validation by default — pass a Zod schema
// via `parseWith` to validate entries as they are read. Validation failures
// throw with the offending line number so callers can pinpoint corruption.

import fs from "node:fs";
import type { ZodType } from "zod";

export interface ReadJsonlOptions<T> {
  parseWith?: ZodType<T>;
}

export function readJsonl<T = unknown>(filePath: string, opts: ReadJsonlOptions<T> = {}): T[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw) return [];

  const out: T[] = [];
  raw.split("\n").forEach((line, i) => {
    if (!line) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `readJsonl: failed to JSON-parse line ${i + 1} of ${filePath}: ${(error as Error).message}`,
      );
    }

    if (opts.parseWith) {
      const result = opts.parseWith.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `readJsonl: line ${i + 1} of ${filePath} failed schema validation: ${result.error.message}`,
        );
      }
      out.push(result.data);
    } else {
      out.push(parsed as T);
    }
  });
  return out;
}

export function appendJsonl(filePath: string, entry: unknown): void {
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}
