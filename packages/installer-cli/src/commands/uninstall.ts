// `librarian uninstall [harness…]` orchestration.
//
// Each harness's `uninstall()` is no-op safe, so we just call them. After
// removing the named (or all) harnesses, if NO harness remains installed we
// OFFER to remove the managed shell block + `~/.librarian/env` — prompting,
// defaulting to NO (we never tear down the user's env without consent).

import fs from "node:fs";
import { readConfig } from "../config.js";
import { detectShell, removeShellBlock, type Shell } from "../env.js";
import { allHarnesses } from "../harnesses/index.js";
import { envFilePath } from "../paths.js";
import type { Prompter } from "../prompt.js";
import { messageOf, resolveNamed } from "./shared.js";

export interface UninstallDeps {
  home?: string | undefined;
  shell?: Shell | undefined;
  prompter: Prompter;
}

export interface UninstallOutcome {
  removed: string[];
  failed: { id: string; reason: string }[];
  envRemoved: boolean;
  output: string;
}

export async function runUninstall(
  named: string[],
  deps: UninstallDeps,
): Promise<UninstallOutcome> {
  const lines: string[] = [];
  const { harnesses, unknown } = resolveNamed(named);
  for (const id of unknown) lines.push(`Skipping unknown harness: ${id}`);

  const removed: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  for (const harness of harnesses) {
    try {
      await harness.uninstall();
      removed.push(harness.id);
    } catch (error) {
      failed.push({ id: harness.id, reason: messageOf(error) });
    }
  }

  lines.push("Uninstall summary:");
  if (removed.length > 0) lines.push(`  Removed: ${removed.join(", ")}`);
  for (const f of failed) lines.push(`  Failed ${f.id}: ${f.reason}`);
  if (removed.length === 0 && failed.length === 0) lines.push("  (nothing to remove)");

  // If nothing remains installed across ALL harnesses, offer to tear down env.
  let envRemoved = false;
  const stillInstalled = await anyInstalled();
  if (!stillInstalled && readConfig(deps.home)) {
    const answer = await deps.prompter.promptText(
      "No harnesses remain installed. Remove the shell block + ~/.librarian/env?",
      { default: "no" },
    );
    if (isYes(answer)) {
      const shell = deps.shell ?? detectShell();
      removeShellBlock(shell, deps.home);
      try {
        fs.rmSync(envFilePath(deps.home));
      } catch {
        // already gone
      }
      envRemoved = true;
      lines.push("", "Removed the managed shell block and ~/.librarian/env.");
    } else {
      lines.push("", "Left the shell block and ~/.librarian/env in place.");
    }
  }

  return { removed, failed, envRemoved, output: lines.join("\n") };
}

/** True iff any harness still reports itself installed. */
async function anyInstalled(): Promise<boolean> {
  const detections = await Promise.all(allHarnesses.map((h) => h.detect()));
  return detections.some((d) => d.installed);
}

function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}
