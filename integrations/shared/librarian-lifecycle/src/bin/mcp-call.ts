#!/usr/bin/env node
// The `mcp-call` helper bin — the sync↔async bridge for the remote transport.
//
// `remote-cli.ts` spawns this per verb (`spawnSync`), so the synchronous
// lifecycle can drive an async HTTP MCP client. It reads the endpoint + token
// from the environment, the verb from argv, and the verb's arguments as JSON on
// stdin; it performs ONE `tools/call`, parses the (prose) response into the
// CliSession-shaped JSON the remote CLI expects, prints it to stdout, and exits
// 0. Any failure prints to stderr and exits non-zero so the remote CLI raises a
// LibrarianCliError and the lifecycle fails soft.

import {
  type McpClient,
  createMcpClient,
  parseSessionFromProse,
  parseSessionListFromProse,
} from "../mcp-client.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? text;
}

function ensureFound(text: string, verb: string): void {
  if (/^No session found/.test(text.trim())) fail(`${verb}: ${firstLine(text)}`);
}

// Drop undefined values so optional args aren't sent as JSON nulls.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function dispatch(
  client: McpClient,
  verb: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (verb) {
    case "start": {
      const text = await client.callTool(
        "start_session",
        compact({
          harness: args.harness,
          source_ref: args.sourceRef,
          cwd: args.cwd,
          project_key: args.projectKey,
          start_summary: args.summary,
          title: args.title,
        }),
      );
      const session = parseSessionFromProse(text);
      if (!session) fail(`start: ${firstLine(text)}`);
      return { session };
    }
    case "list": {
      const text = await client.callTool(
        "list_sessions",
        compact({
          harness: args.harness,
          source_ref: args.sourceRef,
          cwd: args.cwd,
          project_key: args.projectKey,
          status: args.statuses,
        }),
      );
      return { sessions: parseSessionListFromProse(text) };
    }
    case "continue": {
      const text = await client.callTool(
        "continue_session",
        compact({
          session_id: args.sessionId,
          target_harness: args.harness,
          target_cwd: args.cwd,
          target_source_ref: args.sourceRef,
          attach: true,
        }),
      );
      ensureFound(text, "continue");
      // continue_session returns a handover package, not a session block; the id
      // is the one we passed in (the lifecycle only reads .id from the result).
      return {
        session: {
          id: String(args.sessionId),
          status: "active",
          title: null,
          project_key: null,
          source_ref: null,
          cwd: null,
        },
      };
    }
    case "checkpoint": {
      const text = await client.callTool("checkpoint_session", {
        session_id: args.sessionId,
        summary: args.summary,
      });
      ensureFound(text, "checkpoint");
      return { ok: true };
    }
    case "pause": {
      const text = await client.callTool("pause_session", {
        session_id: args.sessionId,
        summary: args.summary,
      });
      ensureFound(text, "pause");
      return { ok: true };
    }
    case "end": {
      const text = await client.callTool(
        "end_session",
        compact({ session_id: args.sessionId, summary: args.reason }),
      );
      ensureFound(text, "end");
      return { ok: true };
    }
    default:
      fail(`unknown verb: ${verb}`);
  }
}

async function main(): Promise<void> {
  const verb = process.argv[2];
  if (!verb) fail("usage: mcp-call <verb> (args on stdin)");

  const endpoint = process.env.LIBRARIAN_MCP_URL;
  const token = process.env.LIBRARIAN_AGENT_TOKEN;
  if (!endpoint || !token) {
    fail("LIBRARIAN_MCP_URL and LIBRARIAN_AGENT_TOKEN must be set");
  }
  const timeoutEnv = Number(process.env.LIBRARIAN_TIMEOUT_MS);

  let args: Record<string, unknown> = {};
  try {
    const raw = (await readStdin()).trim();
    if (raw) args = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    fail("invalid JSON on stdin");
  }

  let client: McpClient;
  try {
    client = createMcpClient({
      endpoint,
      token,
      ...(Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? { timeoutMs: timeoutEnv } : {}),
    });
  } catch (err) {
    fail((err as Error).message);
  }

  try {
    const out = await dispatch(client, verb, args);
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  } catch (err) {
    // McpClientError (and anything else) → stderr + non-zero. The token is never
    // in McpClientError messages (the client guarantees that).
    fail((err as Error).message);
  }
}

void main();
