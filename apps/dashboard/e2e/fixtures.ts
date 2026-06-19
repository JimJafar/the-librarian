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
