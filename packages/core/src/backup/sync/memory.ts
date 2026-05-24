// In-memory BackupTarget — the reference implementation and the test double for
// the target contract (so the bundle round-trip can be tested without a network).

import type { BackupTarget } from "./types.js";

export interface MemoryBackupTarget extends BackupTarget {
  readonly objects: Map<string, Buffer>;
}

export function createMemoryBackupTarget(): MemoryBackupTarget {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(name, data) {
      objects.set(name, Buffer.from(data));
    },
    async get(name) {
      const data = objects.get(name);
      if (!data) throw new Error(`object not found: ${name}`);
      return data;
    },
    async list(prefix = "") {
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
  };
}
