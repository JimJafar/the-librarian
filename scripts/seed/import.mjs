#!/usr/bin/env node
// seed import — bootstrap / re-seed a markdown vault from an external source,
// grooming everything through the consolidator. See README.md.
//
//   node scripts/seed/import.mjs --source <seed-dir> --data-dir <vault-dataDir> \
//        [--extract <extract-dir>] [--wipe --yes]
//
// Needs the curator LLM configured (the consolidator's brain) — the same
// endpoint/model/token the curator uses, read from the store's settings.

import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  createCuratorLlmClient,
  createLibrarianStore,
  readCuratorConfig,
  resolveBootCredentials,
  resolveCuratorToken,
} from "@librarian/core";
import { runSeedImport } from "./lib.mjs";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "data-dir": { type: "string" },
    extract: { type: "string" },
    wipe: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
  strict: true,
});

const source = values.source;
const dataDir = values["data-dir"];
if (!source || !dataDir) {
  console.error(
    "usage: node scripts/seed/import.mjs --source <seed-dir> --data-dir <vault-dataDir> [--extract <dir>] [--wipe --yes]",
  );
  process.exit(2);
}
if (values.wipe && !values.yes) {
  console.error(
    "seed import: --wipe clears the ENTIRE vault (including any live memories that arrived after the initial seed). Re-run with --wipe --yes to confirm.",
  );
  process.exit(1);
}

// `remember` routes to the inbox (→ consolidator) only when this is on.
process.env.LIBRARIAN_CONSOLIDATOR = "on";

const { secretKey } = resolveBootCredentials({
  env: process.env,
  dataDir,
  boundBeyondLocalhost: false,
});
const store = createLibrarianStore({ dataDir, backend: "markdown", secretKey });
try {
  const config = readCuratorConfig(store);
  if (!config.isLlmComplete) {
    console.error(
      "seed import: configure the curator LLM (endpoint/model/token) first — the consolidator needs it to groom.",
    );
    process.exit(1);
  }
  const token = resolveCuratorToken(store);
  if (!token) {
    console.error("seed import: no curator LLM token configured.");
    process.exit(1);
  }
  const llmClient = createCuratorLlmClient({
    endpoint: config.llm.endpoint,
    token,
    model: config.llm.model,
  });

  const summary = await runSeedImport({
    store,
    vaultRoot: path.join(dataDir, "vault"),
    sourceDir: source,
    extractDir: values.extract,
    llmClient,
    wipe: values.wipe,
  });
  console.log(
    `seed import: wiped [${summary.wiped.join(", ")}] · ${summary.referencesCopied} references copied · ${summary.remembered} memories submitted · sweep ${JSON.stringify(summary.sweep)}`,
  );
} finally {
  store.close();
}
