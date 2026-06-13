// `librarian update [harness…]` orchestration.
//
// For each target harness — the named ones, or every CURRENTLY-INSTALLED
// harness when none are named — run its native `update(cfg)` and report the
// version transition (old → new) where both are detectable. Update needs
// config (it re-applies the integration), so it errors clearly if config is
// unset. A "CLI not found" error is a SKIP, not a failure, mirroring install.

import { readConfig } from "../config.js";
import { allHarnesses, type HarnessModule } from "../harnesses/index.js";
import { messageOf, resolveNamed, toHarnessConfig } from "./shared.js";

export interface UpdateDeps {
  home?: string | undefined;
}

export interface UpdateOutcome {
  updated: { id: string; from?: string | undefined; to?: string | undefined }[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; reason: string }[];
  output: string;
}

export async function runUpdate(named: string[], deps: UpdateDeps): Promise<UpdateOutcome> {
  const lines: string[] = [];
  const cfg = readConfig(deps.home);
  if (!cfg || !cfg.mcpUrl || !cfg.token) {
    lines.push("No config set. Run `librarian config --mcp-url <url> --token <token>` first.");
    return { updated: [], skipped: [], failed: [], output: lines.join("\n") };
  }
  const harnessCfg = toHarnessConfig(cfg);

  // Targets: named (validated), else every currently-installed harness.
  const { harnesses: namedHarnesses, unknown } = resolveNamed(named);
  for (const id of unknown) lines.push(`Skipping unknown harness: ${id}`);

  let targets: HarnessModule[];
  if (named.length > 0) {
    targets = namedHarnesses;
  } else {
    const detections = await Promise.all(allHarnesses.map((h) => h.detect()));
    targets = allHarnesses.filter((_, i) => detections[i]?.installed);
    if (targets.length === 0) {
      lines.push("No harnesses are currently installed — nothing to update.");
      return { updated: [], skipped: [], failed: [], output: lines.join("\n") };
    }
  }

  const updated: { id: string; from?: string | undefined; to?: string | undefined }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const harness of targets) {
    const before = (await harness.detect()).version;
    try {
      await harness.update(harnessCfg);
    } catch (error) {
      const reason = messageOf(error);
      if (/not found on path/i.test(reason) || /cli not found/i.test(reason)) {
        skipped.push({ id: harness.id, reason });
        continue;
      }
      failed.push({ id: harness.id, reason });
      continue;
    }
    const after = (await harness.detect()).version;
    updated.push({ id: harness.id, from: before, to: after });
  }

  lines.push("Update summary:");
  for (const u of updated) {
    const transition =
      u.from && u.to
        ? u.from === u.to
          ? `already at ${u.to}`
          : `${u.from} → ${u.to}`
        : u.to
          ? `now ${u.to}`
          : "updated";
    lines.push(`  ${u.id}: ${transition}`);
  }
  for (const s of skipped) lines.push(`  Skipped ${s.id}: ${s.reason}`);
  for (const f of failed) lines.push(`  Failed ${f.id}: ${f.reason}`);
  if (updated.length === 0 && skipped.length === 0 && failed.length === 0) {
    lines.push("  (nothing updated)");
  }

  return { updated, skipped, failed, output: lines.join("\n") };
}
