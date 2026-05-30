// Backup retention (automated-backups A4): keep the newest `keep` bundles, prune
// the rest. The unit is the whole bundle/snapshot. `librarian-backup-<iso>` names
// sort lexically == chronologically, so the oldest are the lowest-sorted; the
// newest (including an in-progress bundle being written) are kept. Each function
// returns the names it removed (never silent).

import fs from "node:fs";
import path from "node:path";
import type { BackupTarget } from "./sync/types.js";

const BACKUP_DIR_PREFIX = "librarian-backup-";

function bundlesToRemove(sortedNames: string[], keep: number): string[] {
  // sortedNames is chronological (oldest first); drop all but the newest `keep`.
  const overflow = Math.max(0, sortedNames.length - Math.max(0, keep));
  return sortedNames.slice(0, overflow);
}

/** Remove all but the newest `keep` local bundle dirs. Returns the removed names. */
export function pruneLocal(dir: string, keep: number): string[] {
  if (!fs.existsSync(dir)) return [];
  const bundles = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(BACKUP_DIR_PREFIX))
    .map((entry) => entry.name)
    .sort();
  const removable = bundlesToRemove(bundles, keep);
  for (const name of removable) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  return removable;
}

/** Delete all but the newest `keep` bundles on a cloud target. Returns removed names. */
export async function pruneTarget(target: BackupTarget, keep: number): Promise<string[]> {
  const keys = await target.list();
  const bundleNames = new Set<string>();
  for (const key of keys) {
    const slash = key.indexOf("/");
    bundleNames.add(slash > 0 ? key.slice(0, slash) : key);
  }
  const removable = bundlesToRemove([...bundleNames].sort(), keep);
  for (const name of removable) {
    await target.deleteBundle(name);
  }
  return removable;
}
