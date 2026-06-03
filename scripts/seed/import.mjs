#!/usr/bin/env node
// seed import — bootstrap / re-seed a markdown vault from an external source,
// grooming everything through the consolidator. See README.md.
//
//   node scripts/seed/import.mjs --source <seed-dir> --data-dir <vault-dataDir> \
//        [--extract <extract-dir>] [--wipe --yes]
//
// Needs the consolidator's LLM (its "brain"). Provide it EITHER directly via
// --endpoint/--model/--token (or LIBRARIAN_SEED_LLM_{ENDPOINT,MODEL,TOKEN}), OR
// let it fall back to the curator config stored in THIS data dir's settings.
// The direct flags are the simplest for a one-off — they don't require the
// target vault's store to already have the curator configured.

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
import { preflightLlm, runSeedImport } from "./lib.mjs";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "data-dir": { type: "string" },
    extract: { type: "string" },
    wipe: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    endpoint: { type: "string" },
    model: { type: "string" },
    token: { type: "string" },
  },
  strict: true,
});

// Build the consolidator's LLM client: explicit flags/env win; otherwise the
// curator config persisted in this store's settings.
function resolveLlmClient(store, dataDir) {
  const endpoint = values.endpoint ?? process.env.LIBRARIAN_SEED_LLM_ENDPOINT;
  const model = values.model ?? process.env.LIBRARIAN_SEED_LLM_MODEL;
  const token = values.token ?? process.env.LIBRARIAN_SEED_LLM_TOKEN;
  if (endpoint && model && token) return createCuratorLlmClient({ endpoint, token, model });

  const config = readCuratorConfig(store);
  const storedToken = config.isLlmComplete ? resolveCuratorToken(store) : null;
  if (config.isLlmComplete && storedToken) {
    return createCuratorLlmClient({
      endpoint: config.llm.endpoint,
      token: storedToken,
      model: config.llm.model,
    });
  }

  console.error(
    `seed import: no consolidator LLM available.\n` +
      `  Read curator config from ${path.join(dataDir, "settings.json")} — ` +
      `endpoint=${config.llm.endpoint ? "set" : "missing"}, model=${config.llm.model ? "set" : "missing"}, token=${config.hasToken ? "set" : "missing"}.\n` +
      `  Either pass --endpoint <url> --model <id> --token <key> directly, or run with --data-dir pointing at the\n` +
      `  markdown store whose dashboard you configured the curator in (the config lives in that store's settings).`,
  );
  return null;
}

const source = values.source;
const dataDirArg = values["data-dir"];
if (!source || !dataDirArg) {
  console.error(
    "usage: node scripts/seed/import.mjs --source <seed-dir> --data-dir <vault-dataDir>\n" +
      "         [--extract <dir>] [--wipe --yes] [--endpoint <url> --model <id> --token <key>]",
  );
  process.exit(2);
}
if (values.wipe && !values.yes) {
  console.error(
    "seed import: --wipe clears the ENTIRE vault (including any live memories that arrived after the initial seed). Re-run with --wipe --yes to confirm.",
  );
  process.exit(1);
}

// Absolute so the vault's path-escape guard doesn't trip on a relative root.
const dataDir = path.resolve(dataDirArg);

// `remember` routes to the inbox (→ consolidator) only when this is on.
process.env.LIBRARIAN_CONSOLIDATOR = "on";

const { secretKey } = resolveBootCredentials({
  env: process.env,
  dataDir,
  boundBeyondLocalhost: false,
});
const store = createLibrarianStore({ dataDir, backend: "markdown", secretKey });
try {
  const llmClient = resolveLlmClient(store, dataDir);
  if (!llmClient) process.exit(1);

  // Fail-fast: one cheap call so a bad endpoint/model/token dies in ~2s, before
  // loading the embedder and replaying every memory.
  process.stdout.write("seed import: checking the consolidator LLM… ");
  try {
    await preflightLlm(llmClient);
    console.log("ok");
  } catch (error) {
    console.log("failed");
    console.error(
      `seed import: the consolidator LLM rejected a test call — fix this before re-running.\n` +
        `  ${error instanceof Error ? error.message : String(error)}\n` +
        `  (check --endpoint / --model / --token, or the curator config in the dashboard.)`,
    );
    process.exit(1);
  }

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
  if (summary.errors?.length) {
    console.error(
      `\nseed import: the consolidator sweep errored. First distinct error(s):\n  - ${summary.errors.join("\n  - ")}\n` +
        `(usually a bad --model / --token / --endpoint — every item hits the same LLM error.)`,
    );
  }
} finally {
  store.close();
}
