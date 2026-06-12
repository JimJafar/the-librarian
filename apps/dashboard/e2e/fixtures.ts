import { request, type APIRequestContext } from "@playwright/test";

const SERVER_URL = process.env.LIBRARIAN_E2E_SERVER_URL ?? "http://127.0.0.1:3838";
const ADMIN_TOKEN = process.env.LIBRARIAN_E2E_ADMIN_TOKEN ?? "e2e-admin-token";

async function adminContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: SERVER_URL,
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
  overrides: { project_key?: string; agent_id?: string } = {},
): Promise<{ id: string }> {
  const ctx = await adminContext();
  try {
    const result = await trpcMutation<CreatedMemory>(ctx, "memories.create", {
      title,
      body,
      ...(overrides.project_key ? { project_key: overrides.project_key } : {}),
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
