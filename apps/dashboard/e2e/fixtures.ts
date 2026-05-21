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

async function mcpCallText(
  ctx: APIRequestContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  // MCP `tools/call` returns `{ content: [{ type: "text", text: "..." }] }`
  // by convention. The Librarian's start_session embeds the new session id
  // in that prose payload as `ID: ses_…`, which we parse out below.
  const response = await ctx.post("/mcp", {
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    headers: { "content-type": "application/json" },
  });
  if (!response.ok()) {
    throw new Error(`MCP ${name} failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as {
    result?: { content?: Array<{ type: string; text?: string }> };
    error?: { message?: string };
  };
  if (body.error) throw new Error(`MCP ${name} returned error: ${body.error.message}`);
  return body.result?.content?.map((c) => c.text ?? "").join("") ?? "";
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
      category: "lessons",
      visibility: "common",
      scope: "global",
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

export async function createTestSession(title: string): Promise<{ id: string }> {
  // `start_session` is only on the MCP surface (not tRPC), so we drive it
  // via the JSON-RPC `tools/call` endpoint with the admin bearer.
  const ctx = await adminContext();
  try {
    const text = await mcpCallText(ctx, "start_session", {
      title,
      harness: "claude-code",
      source_ref: "e2e:test",
      cwd: "/tmp/e2e",
      project_key: "the-librarian",
    });
    const match = text.match(/ID:\s*(ses_[a-z0-9-]+)/i);
    if (!match) throw new Error(`start_session text did not contain an id: ${text}`);
    return { id: match[1]! };
  } finally {
    await ctx.dispose();
  }
}
