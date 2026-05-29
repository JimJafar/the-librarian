# 032 — Remove the embedded local classifier provider

**Status:** Done. Supersedes the local-provider portions of
[`023-classifier-implementation-spec.md`](./023-classifier-implementation-spec.md)
and [`031-classifier-dashboard-config-spec.md`](./031-classifier-dashboard-config-spec.md).

## Context

The async memory classifier shipped with two provider modes:

- **remote** — an OpenAI-compatible HTTP endpoint.
- **local** — GGUF models run in-process via `node-llama-cpp`, an optional
  ~300MB native dependency, loaded on a Node `Worker` thread, with a curated
  model catalog and HuggingFace auto-download plumbing.

The local mode was a large surface area — native binary, worker host/worker
protocol, model catalog, download URIs, lifecycle teardown, a node-llama-cpp
install probe — for a feature most operators won't use. It was also actively
hostile to the container deployment: `docker/mcp-server.Dockerfile` builds with
`pnpm install --ignore-scripts` (so the native binary never lands) and the
runtime container is `read_only: true` + non-root (so it can't self-install).
The boot probe surfaced a friendly-but-dead-end error telling operators to
`pnpm add node-llama-cpp` — something the container cannot honour.

## Decision

**Remove the embedded local provider entirely. Remote becomes the only mode.**

This loses no capability: remote mode speaks an OpenAI-compatible API, so
"run a model locally" is still fully supported by pointing the endpoint at a
local server URL — **ollama, vllm, or a llama.cpp server** — and it also
unlocks fast hosted models (e.g. Haiku). Net result: less code, no 300MB
native binary, no Docker footgun, same capability.

The `providerMode` discriminator is removed wholesale rather than left as a
vestigial single-value enum.

## End state

- `@librarian/classifier` exposes only the remote provider. The `local.ts`,
  `local-worker-host.ts`, `local.worker.ts`, and `catalog.ts` modules (and their
  tests) are deleted; `node-llama-cpp` is removed from `optionalDependencies`
  and the `./catalog` export subpath is gone.
- `@librarian/core` `ClassifierConfig` drops `providerMode` and the `local`
  block. `isOperational === enabled && isLlmComplete`. The `classifier.local.*`
  and `classifier.provider_mode` setting keys are no longer read or written.
- `mcp-server` boot/restart/self-test paths have no local branch, no
  node-llama-cpp probe, and no Node-Worker lifecycle teardown (remote has no
  thread to terminate). A test-only `_llm` factory seam replaces the old
  `_inferenceFor` seam.
- The `/classifier` dashboard cockpit shows only the remote LLM-connection
  form — no provider toggle, no model catalog, no quantisation field.
- `classifier-eval`'s `--provider` accepts only `remote`.

## Migration

None required. `provider_mode` defaulted to `remote` and unknown stored values
already fall back to the default, so a deployment with a persisted
`provider_mode = "local"` simply reads back as `remote` and reports
"not operational — configure the LLM connection" until an endpoint is set.
Orphaned `classifier.local.*` setting rows become inert and are ignored.

One cosmetic side effect: `classifierConfigHash` no longer includes
`providerMode`/`local`, so the stored hash changes once on first deploy,
showing a one-time "config drift" banner in the dashboard that clears on the
next worker restart.

## Verification

- `pnpm -r build` + `pnpm --filter dashboard typecheck` — no dangling
  provider-mode/local types.
- `pnpm -r test` — deleted local suites gone; remote suites green
  (core 465, classifier 26, classifier-eval 50, mcp-server 144).
- `git diff pnpm-lock.yaml` — `node-llama-cpp` + all `@node-llama-cpp/*`
  platform packages removed.
- Boot smoke test: a store with a leftover `provider_mode = "local"` boots
  without error and reports the classifier as not operational.
