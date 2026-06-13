// Which native CLI binary (if any) each harness drives.
//
// The `HarnessModule` interface deliberately doesn't expose this — the
// modules are thin and uniform. But the orchestration layer needs it for two
// things: choosing the default install set (harnesses whose CLI is on PATH)
// and the `doctor` report ("which harness CLIs are present?"). File-based
// harnesses (opencode, hermes) have no CLI gate, so they map to `null`.

import type { HarnessId } from "./types.js";

/** Harness id → the native CLI binary it drives, or `null` if file-based. */
export const HARNESS_CLI: Record<HarnessId, string | null> = {
  claude: "claude",
  codex: "codex",
  opencode: null,
  hermes: null,
  pi: "pi",
};
