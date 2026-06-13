// `librarian install [harness…]` orchestration.
//
// Flow:
//   1. Resolve config. If the MCP URL or token is unset, prompt for them
//      (token is a SECRET prompt — never echoed) and persist via `setConfig`,
//      which also (re)applies the managed shell block for the user's shell.
//   2. Choose harnesses: explicit args win; otherwise an interactive
//      multi-select over the harnesses whose native CLI is on PATH (file-based
//      harnesses always offered). Non-interactive falls back to all available.
//   3. For each chosen harness, run its native `install(cfg)`:
//        - a "CLI not found" error → SKIP with a note (not a failure);
//        - any OTHER error → attempt `uninstall()` to avoid a half-applied
//          state (spec §9), record it failed, and continue.
//   4. Print a summary (installed / skipped / failed) + a restart hint.

import { readConfig, setConfig, type LibrarianConfig } from "../config.js";
import type { Shell } from "../env.js";
import { which } from "../exec.js";
import { HARNESS_CLI } from "../harnesses/cli.js";
import { allHarnesses, isHarnessId, type HarnessModule } from "../harnesses/index.js";
import type { Prompter } from "../prompt.js";
import { messageOf, toHarnessConfig } from "./shared.js";

export interface InstallDeps {
  home?: string | undefined;
  shell?: Shell | undefined;
  prompter: Prompter;
}

export interface InstallOutcome {
  installed: string[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; reason: string }[];
  output: string;
}

/** Run the install orchestration over the (possibly empty) named harnesses. */
export async function runInstall(named: string[], deps: InstallDeps): Promise<InstallOutcome> {
  const lines: string[] = [];

  // 1) Resolve config, prompting for any missing secret/URL.
  const cfg = await resolveConfig(deps, lines);

  // 2) Choose harnesses.
  const chosen = await chooseHarnesses(named, deps, lines);
  if (chosen.length === 0) {
    lines.push("No harnesses selected — nothing to do.");
    return { installed: [], skipped: [], failed: [], output: lines.join("\n") };
  }

  // 3) Install each, with per-harness skip / rollback.
  const harnessCfg = toHarnessConfig(cfg);
  const installed: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const harness of chosen) {
    try {
      await harness.install(harnessCfg);
      installed.push(harness.id);
    } catch (error) {
      const reason = messageOf(error);
      if (isCliNotFound(reason)) {
        skipped.push({ id: harness.id, reason });
        continue;
      }
      // Mid-install failure → roll back so we don't leave a half-applied
      // state (spec §9). Best-effort: a failed rollback is noted, not fatal.
      let rollbackNote = "";
      try {
        await harness.uninstall();
        rollbackNote = " (rolled back)";
      } catch (rollbackError) {
        rollbackNote = ` (rollback also failed: ${messageOf(rollbackError)})`;
      }
      failed.push({ id: harness.id, reason: `${reason}${rollbackNote}` });
    }
  }

  // 4) Summary + restart hint.
  renderSummary(lines, { installed, skipped, failed });
  return { installed, skipped, failed, output: lines.join("\n") };
}

/** Read config, prompting for whatever is missing; persist + apply env. */
async function resolveConfig(deps: InstallDeps, lines: string[]): Promise<LibrarianConfig> {
  const existing = readConfig(deps.home);
  let mcpUrl = existing?.mcpUrl ?? "";
  let token = existing?.token ?? "";

  if (!mcpUrl) {
    mcpUrl = await deps.prompter.promptText("MCP URL");
  }
  if (!token) {
    token = await deps.prompter.promptText("Agent token", { secret: true });
  }

  // Only persist when something changed (keeps re-runs idempotent + quiet).
  if (mcpUrl !== existing?.mcpUrl || token !== existing?.token) {
    const updated = setConfig({ mcpUrl, token }, { home: deps.home, shell: deps.shell });
    lines.push("Saved config to ~/.librarian/env and updated the shell block.", "");
    return updated;
  }
  return existing as LibrarianConfig;
}

/**
 * Resolve the harness set to install into:
 *   - explicit args (validated) win;
 *   - otherwise interactive multi-select over harnesses whose CLI is present
 *     (file-based harnesses always offered).
 */
async function chooseHarnesses(
  named: string[],
  deps: InstallDeps,
  lines: string[],
): Promise<HarnessModule[]> {
  if (named.length > 0) {
    const valid: HarnessModule[] = [];
    for (const id of named) {
      if (isHarnessId(id)) {
        valid.push(allHarnesses.find((h) => h.id === id) as HarnessModule);
      } else {
        lines.push(`Skipping unknown harness: ${id}`);
      }
    }
    return valid;
  }

  // Default set: harnesses whose CLI is on PATH, plus file-based ones.
  const available: HarnessModule[] = [];
  for (const harness of allHarnesses) {
    const cli = HARNESS_CLI[harness.id];
    if (cli === null || (await which(cli))) available.push(harness);
  }
  if (available.length === 0) {
    lines.push("No harness CLIs detected on PATH.");
    return [];
  }

  const selectedIds = await deps.prompter.selectHarnesses(
    available.map((h) => ({ id: h.id, label: h.displayName })),
  );
  return available.filter((h) => selectedIds.includes(h.id));
}

function renderSummary(
  lines: string[],
  outcome: {
    installed: string[];
    skipped: { id: string; reason: string }[];
    failed: { id: string; reason: string }[];
  },
): void {
  lines.push("", "Install summary:");
  if (outcome.installed.length > 0) {
    lines.push(`  Installed: ${outcome.installed.join(", ")}`);
  }
  for (const s of outcome.skipped) {
    lines.push(`  Skipped ${s.id}: ${s.reason}`);
  }
  for (const f of outcome.failed) {
    lines.push(`  Failed ${f.id}: ${f.reason}`);
  }
  if (
    outcome.installed.length === 0 &&
    outcome.failed.length === 0 &&
    outcome.skipped.length === 0
  ) {
    lines.push("  (nothing installed)");
  }
  lines.push(
    "",
    "Restart your shell or run `source ~/.librarian/env` to load the new environment.",
  );
}

/** True iff the error message is a harness "CLI not found on PATH" signal. */
function isCliNotFound(message: string): boolean {
  return /not found on path/i.test(message) || /cli not found/i.test(message);
}
