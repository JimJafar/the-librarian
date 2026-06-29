// MCP dispatch — thin router over the tool registry in `./tools/`.
//
// Owns the JSON-RPC envelope (`handleMcpPayload` / `handleMcpMessage`)
// and the `initialize` / `tools/list` / `tools/call` / `resources/*`
// methods. Every callable tool lives in `./tools/<verb>.ts`.

import { DEFAULT_AGENT_ID, formatRecall, type LibrarianStore, readPrimer } from "@librarian/core";
import { logger } from "../logging.js";
import { handleMcpMessage, handleMcpPayload } from "./rpc.js";
import type { ToolContext, ToolDefinition } from "./tool.js";
import { tools, toolsByName } from "./tools/index.js";
import { visibleResourceMemories } from "./visibility.js";

export { handleMcpMessage, handleMcpPayload, tools };

export async function dispatchMcp(
  store: LibrarianStore,
  method: string,
  params: Record<string, unknown> = {},
  context: { role?: ToolContext["role"]; agentId?: string | undefined } = {},
): Promise<unknown> {
  const role: ToolContext["role"] = context.role || "agent";
  const toolContext: ToolContext = { role, agentId: context.agentId };

  if (method === "initialize") {
    // The primer rides the initialize result's `instructions` field (rethink
    // T11 / D10) — the connect-time teaching channel every MCP harness renders
    // into the system layer. Read per connection (the store caches the file and
    // refreshes on write), never snapshotted at process start, so an admin edit
    // reaches the next session without a restart. Fail-soft: an unreadable or
    // operator-disabled ("") primer omits the field rather than blocking init.
    const instructions = readPrimer(store);
    return {
      protocolVersion: (params.protocolVersion as string) || "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "the-librarian", version: "0.1.0" },
      ...(instructions ? { instructions } : {}),
    };
  }
  if (method === "tools/list") return { tools: toolsForRole(role).map(toWireTool) };
  if (method === "tools/call") {
    return callTool(
      store,
      params.name as string,
      (params.arguments as Record<string, unknown>) || {},
      toolContext,
    );
  }
  if (method === "resources/list") {
    return {
      resources: [
        {
          uri: "librarian://memories",
          name: "The Librarian Memories",
          description:
            role === "admin"
              ? "Human-readable memory snapshot."
              : "Human-readable common memory snapshot.",
          mimeType: "text/markdown",
        },
      ],
    };
  }
  if (method === "resources/read" && params.uri === "librarian://memories") {
    const memories = visibleResourceMemories(store, toolContext);
    return {
      contents: [
        {
          uri: "librarian://memories",
          mimeType: "text/markdown",
          text: formatRecall(memories, "The Librarian Memories"),
        },
      ],
    };
  }
  throw new Error(`Unsupported method: ${method}`);
}

function callTool(
  store: LibrarianStore,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): ReturnType<ToolDefinition["handler"]> {
  const tool = toolsByName.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (tool.adminOnly && context.role !== "admin") {
    throw new Error(`Tool ${name} requires admin authorization.`);
  }
  warnIfMissingIdentity(name, args, context);
  return tool.handler(store, args, context);
}

// Soft-migration observability (§9 Phase 1). When an agent call carries no
// identity — no token-bound id and no request-body `agent_id` — the resolver
// falls back to the `unknown-agent` sentinel. Log each such call so we can
// confirm the Stage 4 hard-enforcement gate ("no new unknown-agent rows for
// 7 consecutive days") before flipping it. Admin calls don't carry an agent
// identity by design, so they're exempt.
//
// The predicate below mirrors the resolver's own fallback condition
// (`firstSupplied`/`hasValue` in core's caller-identity, fed by `scopeAgentArgs`).
// It's re-derived here because this is the only layer with the tool name; keep
// it in sync if `scopeAgentArgs` ever starts feeding the resolver new id sources.
function warnIfMissingIdentity(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): void {
  if (context.role !== "agent") return;
  if (context.agentId && context.agentId.trim() !== "") return;
  if (typeof args.agent_id === "string" && args.agent_id.trim() !== "") return;

  const bindings: Record<string, unknown> = { tool: name, actor_id: DEFAULT_AGENT_ID };
  if (typeof args.harness === "string") bindings.harness = args.harness;
  if (typeof args.source_ref === "string") bindings.source_ref = args.source_ref;
  logger.warn(
    bindings,
    `agent call to "${name}" supplied no identity; falling back to ${DEFAULT_AGENT_ID} (soft-migration)`,
  );
}

function toolsForRole(role: ToolContext["role"]): ToolDefinition[] {
  if (role === "admin") return tools;
  return tools.filter((tool) => !tool.adminOnly);
}

// The agent-facing wire shape: name + tool-level teaching description + the
// lean input schema. Per-parameter human descriptions are authored inline on
// each `inputSchema` as the single source of truth for the docs generator, but
// they are docs-only — stripped here so a `tools/list` payload never spends an
// agent's context on prose it can't act on (docs-site spec K7). The tool-level
// `description` is the deliberate teaching surface and is preserved verbatim.
interface WireTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function toWireTool(tool: ToolDefinition): WireTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: stripSchemaDescriptions(tool.inputSchema) as Record<string, unknown>,
  };
}

// Deep-clone a JSON-Schema value with every `description` key removed, so no
// per-property prose survives onto the wire. Operates on a copy — the registry
// objects (and the docs generator's source of truth) keep their descriptions.
function stripSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaDescriptions);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "description") continue;
      out[key] = stripSchemaDescriptions(child);
    }
    return out;
  }
  return value;
}
