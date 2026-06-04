#!/usr/bin/env node
// Guard: the markdown vault is now `git push`ed as the backup, so it must NEVER
// contain secrets. Build a real markdown store, write a secret setting (the kind
// of value the master key encrypts) plus an ordinary memory, then assert:
//   1. the secret's plaintext appears nowhere under the vault working tree, and
//   2. the secret-bearing sidecar files (secret.key, settings.json) live OUTSIDE
//      the vault — as siblings in the data dir, never inside the pushed repo.
//
// This pins the storage invariant: secrets route to encrypted sidecars outside
// the vault; only durable knowledge (plaintext memories) goes into the vault.
// (Scanning the vault's git *history* for secrets is a heavier forensic check —
// noted as a follow-up; this catches the code-level "routed a secret into the
// vault" regression.)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SECRET = "ghp_canary_THIS_MUST_NEVER_REACH_THE_VAULT_0123456789abcd";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-vault-secrets-"));
const failures = [];

try {
  const { createLibrarianStore, resolveSecretKey } = await import("@librarian/core");
  const key = resolveSecretKey("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  const store = createLibrarianStore({ dataDir, backend: "markdown", secretKey: key });
  try {
    store.setSetting("backup.github.token", SECRET, { secret: true });
    store.createMemory({
      agent_id: "guard",
      title: "an ordinary memory",
      body: "ordinary content",
    });
  } finally {
    store.close();
  }

  const vaultDir = path.join(dataDir, "vault");

  for (const file of walk(vaultDir)) {
    if (fs.readFileSync(file).includes(SECRET)) {
      failures.push(`secret plaintext found in vault file: ${path.relative(dataDir, file)}`);
    }
  }

  for (const name of ["secret.key", "settings.json"]) {
    if (fs.existsSync(path.join(vaultDir, name))) {
      failures.push(`${name} must live OUTSIDE the vault (it is part of the pushed backup)`);
    }
  }
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error("[check-no-secrets-in-vault] FAIL:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  "[check-no-secrets-in-vault] OK: no secret plaintext under the vault; secret store is outside it.",
);

// Walk the vault working tree, skipping its `.git` dir (compressed objects — the
// working tree is what a substring scan can meaningfully check).
function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}
