import { execFileSync } from "node:child_process";
import { request, type APIRequestContext } from "@playwright/test";

// ADR 0008 P1/P3: admin tRPC lives on the internal listener now, not the
// published agent port. A Bearer is still sent but the internal listener is
// trusted by isolation, so it's no longer required.
const TRPC_URL = process.env.LIBRARIAN_E2E_TRPC_URL ?? "http://127.0.0.1:3840";
const ADMIN_TOKEN = process.env.LIBRARIAN_E2E_ADMIN_TOKEN ?? "e2e-admin-token";

async function adminContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: TRPC_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

// tRPC single-call HTTP shape (no transformer, no batch): the request
// body is the raw input JSON, the response is `{ result: { data: <out> } }`.
async function trpcMutation<T>(
  ctx: APIRequestContext,
  procedure: string,
  input: unknown,
): Promise<T> {
  const response = await ctx.post(`/trpc/${procedure}`, {
    data: input as object,
    headers: { "content-type": "application/json" },
  });
  if (!response.ok()) {
    throw new Error(`tRPC ${procedure} failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { result?: { data?: T } };
  return body.result?.data as T;
}

interface CreatedMemory {
  memory: { id: string; title: string };
}

export async function createTestMemory(
  title: string,
  body: string,
  overrides: { agent_id?: string } = {},
): Promise<{ id: string }> {
  const ctx = await adminContext();
  try {
    const result = await trpcMutation<CreatedMemory>(ctx, "memories.create", {
      title,
      body,
      ...(overrides.agent_id ? { agent_id: overrides.agent_id } : {}),
    });
    if (!result?.memory?.id) {
      throw new Error(`createMemory returned no id: ${JSON.stringify(result)}`);
    }
    return { id: result.memory.id };
  } finally {
    await ctx.dispose();
  }
}

// The data dir the live e2e mcp-server is bound to (playwright.config.ts exports
// it to process.env at config-load time). Proposal seeding writes here.
function e2eDataDir(): string {
  const dir = process.env.LIBRARIAN_E2E_DATA_DIR;
  if (!dir) {
    throw new Error(
      "LIBRARIAN_E2E_DATA_DIR is unset — playwright.config.ts must export it before specs run.",
    );
  }
  return dir;
}

// @librarian/core is an ESM-only package ("type":"module", exports declare only
// the `import` condition). The Playwright runner loads specs as CommonJS, where
// `require("@librarian/core")` fails ("No exports main defined"). So run the
// store interaction OUT OF PROCESS as a Node ESM one-liner, where core resolves
// normally. The script prints a single JSON line we parse back.
function runStoreScript(source: string, payload: Record<string, unknown>): unknown {
  const out = execFileSync("node", ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, LIBRARIAN_STORE_PAYLOAD: JSON.stringify(payload) },
  });
  const line = out.trim().split("\n").pop() ?? "{}";
  return JSON.parse(line);
}

// Seed a PROPOSED memory directly into the e2e store's data dir, the same way
// the unit/router tests do. The admin tRPC `memories.create` always
// auto-applies (status `active`); a proposal needs the trusted options channel
// (`requires_approval: true` + a self-describing `curator_note`), which no admin
// endpoint exposes. The markdown store is file/git-backed and the /proposals
// page is `force-dynamic` (re-reads from disk per request), so a memory written
// here is visible to the running server on its next read. Returns the new id.
export async function seedProposal(opts: {
  title: string;
  body: string;
  agent_id?: string;
  curatorNote: Record<string, unknown>;
}): Promise<{ id: string }> {
  const result = runStoreScript(
    `
    import { createLibrarianStore } from "@librarian/core";
    const p = JSON.parse(process.env.LIBRARIAN_STORE_PAYLOAD);
    const store = createLibrarianStore({ dataDir: p.dataDir });
    try {
      const r = store.createMemory(
        { agent_id: p.agent_id, title: p.title, body: p.body },
        { requires_approval: true, curator_note: p.curatorNote },
      );
      process.stdout.write(JSON.stringify({ id: r.memory.id }));
    } finally {
      store.close();
    }
  `,
    {
      dataDir: e2eDataDir(),
      agent_id: opts.agent_id ?? "scribe",
      title: opts.title,
      body: opts.body,
      curatorNote: opts.curatorNote,
    },
  ) as { id: string };
  return { id: result.id };
}

// Read one memory's status straight from the e2e store (so a spec can assert a
// source was archived on approve without round-tripping the dashboard).
export async function readMemoryStatus(id: string): Promise<string | null> {
  const result = runStoreScript(
    `
    import { createLibrarianStore } from "@librarian/core";
    const p = JSON.parse(process.env.LIBRARIAN_STORE_PAYLOAD);
    const store = createLibrarianStore({ dataDir: p.dataDir });
    try {
      const m = store.getMemory(p.id);
      process.stdout.write(JSON.stringify({ status: m?.status ?? null }));
    } finally {
      store.close();
    }
  `,
    { dataDir: e2eDataDir(), id },
  ) as { status: string | null };
  return result.status;
}
