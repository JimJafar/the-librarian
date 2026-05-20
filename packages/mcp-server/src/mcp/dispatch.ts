// MCP dispatch — thin router over the tool registry in `./tools/`.
//
// Owns the JSON-RPC envelope (`handleMcpPayload` / `handleMcpMessage`)
// and the `initialize` / `tools/list` / `tools/call` / `resources/*`
// methods. Every callable tool lives in `./tools/<verb>.ts`.

import { formatRecall, type LibrarianStore } from "@librarian/core";
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
    return {
      protocolVersion: (params.protocolVersion as string) || "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "the-librarian", version: "0.1.0" },
    };
  }
  if (method === "tools/list") return { tools: toolsForRole(role) };
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
  return tool.handler(store, args, context);
}

function toolsForRole(role: ToolContext["role"]): ToolDefinition[] {
  if (role === "admin") return tools;
  return tools.filter((tool) => !tool.adminOnly);
}
