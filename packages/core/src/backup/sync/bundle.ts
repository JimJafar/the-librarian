// Push/pull a local backup bundle (a directory of files) to/from a BackupTarget.
// Objects are keyed `<bundleName>/<file>`, so one target can hold many bundles.

import fs from "node:fs";
import path from "node:path";
import type { BackupTarget } from "./types.js";

/** Upload every file in `backupDir` under `<basename(backupDir)>/`. Returns the keys. */
export async function syncBundle(target: BackupTarget, backupDir: string): Promise<string[]> {
  const bundleName = path.basename(backupDir);
  const keys: string[] = [];
  for (const file of fs.readdirSync(backupDir)) {
    const key = `${bundleName}/${file}`;
    await target.put(key, fs.readFileSync(path.join(backupDir, file)));
    keys.push(key);
  }
  return keys;
}

/** Download the `<bundleName>/` objects into `<destDir>/<bundleName>/`; returns that path. */
export async function fetchBundle(
  target: BackupTarget,
  bundleName: string,
  destDir: string,
): Promise<string> {
  const prefix = `${bundleName}/`;
  const keys = await target.list(prefix);
  if (keys.length === 0) throw new Error(`no backup objects under ${prefix}`);
  const dir = path.join(destDir, bundleName);
  fs.mkdirSync(dir, { recursive: true });
  for (const key of keys) {
    const file = key.slice(prefix.length);
    // A target must never write outside the bundle dir.
    if (!file || file.includes("/") || file.includes("\\") || file.includes("..")) {
      throw new Error(`unsafe object key: ${key}`);
    }
    fs.writeFileSync(path.join(dir, file), await target.get(key));
  }
  return dir;
}
