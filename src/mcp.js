import { formatRecall } from "./store.js";
import { DEFAULT_AGENT_ID } from "./constants.js";

export const tools = [
  {
    name: "start_context",
    description: "Return required clean prose context for an agent at task start.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        project_key: { type: "string" },
        task_summary: { type: "string" }
      }
    }
  },
  {
    name: "recall",
    description: "Search memories by query and filters. Returns clean prose only.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        query: { type: "string" },
        categories: { type: "array", items: { type: "string" } },
        project_key: { type: "string" },
        include_private: { type: "boolean" },
        limit: { type: "number" }
      }
    }
  },
  {
    name: "remember",
    description: "Save a durable memory. Protected categories become proposals.",
    inputSchema: memoryInputSchema()
  },
  {
    name: "propose_memory",
    description: "Create a proposed memory for review.",
    inputSchema: memoryInputSchema()
  },
  {
    name: "update_memory",
    description: "Edit a memory while preserving history.",
    inputSchema: {
      type: "object",
      required: ["memory_id", "patch"],
      properties: {
        agent_id: { type: "string" },
        memory_id: { type: "string" },
        patch: { type: "object" }
      }
    }
  },
  {
    name: "delete_memory",
    description: "Tombstone a memory.",
    inputSchema: {
      type: "object",
      required: ["memory_id"],
      properties: {
        agent_id: { type: "string" },
        memory_id: { type: "string" }
      }
    }
  },
  {
    name: "verify_memory",
    description: "Record whether a memory was useful, stale, wrong, or not useful.",
    inputSchema: {
      type: "object",
      required: ["memory_id", "result"],
      properties: {
        agent_id: { type: "string" },
        memory_id: { type: "string" },
        result: { type: "string", enum: ["useful", "not_useful", "outdated", "wrong"] },
        note: { type: "string" }
      }
    }
  },
  {
    name: "list_proposals",
    description: "List pending proposed memories.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" }
      }
    }
  },
  {
    name: "approve_proposal",
    description: "Approve, edit, or reject a proposed memory.",
    inputSchema: {
      type: "object",
      required: ["memory_id"],
      properties: {
        agent_id: { type: "string" },
        memory_id: { type: "string" },
        action: { type: "string", enum: ["approve", "reject"] },
        patch: { type: "object" }
      }
    }
  },
  {
    name: "resolve_conflict",
    description: "Resolve conflicts between non-protected memories.",
    inputSchema: {
      type: "object",
      required: ["memory_ids", "resolution"],
      properties: {
        agent_id: { type: "string" },
        memory_ids: { type: "array", items: { type: "string" } },
        resolution: { type: "string", enum: ["supersede", "keep_both", "archive", "edit"] },
        explanation: { type: "string" },
        patch: { type: "object" }
      }
    }
  }
];

const ADMIN_TOOL_NAMES = new Set(["approve_proposal", "delete_memory", "resolve_conflict"]);

export async function dispatchMcp(store, method, params = {}, context = {}) {
  const role = context.role || "agent";
  if (method === "initialize") {
    return {
      protocolVersion: params.protocolVersion || "2025-06-18",
      capabilities: {
        tools: {},
        resources: {}
      },
      serverInfo: {
        name: "the-librarian",
        version: "0.1.0"
      }
    };
  }

  if (method === "tools/list") return { tools: toolsForRole(role) };
  if (method === "tools/call") return callTool(store, params.name, params.arguments || {}, context);
  if (method === "resources/list") {
    const description = role === "admin"
      ? "Human-readable memory snapshot."
      : "Human-readable common memory snapshot.";
    return {
      resources: [
        {
          uri: "librarian://memories",
          name: "The Librarian Memories",
          description,
          mimeType: "text/markdown"
        }
      ]
    };
  }
  if (method === "resources/read" && params.uri === "librarian://memories") {
    const memories = visibleResourceMemories(store, context);
    return {
      contents: [
        {
          uri: "librarian://memories",
          mimeType: "text/markdown",
          text: formatRecall(memories, "The Librarian Memories")
        }
      ]
    };
  }

  throw new Error(`Unsupported method: ${method}`);
}

export async function handleMcpMessage(store, message, context = {}) {
  if (!message || message.jsonrpc !== "2.0") {
    return rpcError(message?.id ?? null, -32600, "Invalid JSON-RPC request");
  }
  try {
    const result = await dispatchMcp(store, message.method, message.params || {}, context);
    if (message.id === undefined) return null;
    return { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    if (message.id === undefined) return null;
    return rpcError(message.id, -32000, error.message);
  }
}

export async function handleMcpPayload(store, payload, context = {}) {
  if (Array.isArray(payload)) {
    const responses = [];
    for (const message of payload) {
      const response = await handleMcpMessage(store, message, context);
      if (response) responses.push(response);
    }
    return responses;
  }
  return handleMcpMessage(store, payload, context);
}

function callTool(store, name, args, context = {}) {
  const role = context.role || "agent";
  const scopedArgs = scopeAgentArgs(args, context);
  if (ADMIN_TOOL_NAMES.has(name) && role !== "admin") {
    throw new Error(`Tool ${name} requires admin authorization.`);
  }

  if (name === "start_context") {
    const result = store.startContext(scopedArgs);
    return textResult(result.text);
  }

  if (name === "recall") {
    const memories = store.searchMemories(scopedArgs);
    store.recordRecall(memories, scopedArgs.agent_id || DEFAULT_AGENT_ID, scopedArgs.query || "");
    return textResult(formatRecall(memories));
  }

  if (name === "remember") {
    const result = store.createMemory(scopedArgs);
    if (result.status === "conflict") {
      return textResult(formatConflict(result));
    }
    const suffix = result.status === "proposed"
      ? "This memory is protected and has been saved as a proposal for review."
      : "Memory saved.";
    const duplicateText = result.duplicates?.length
      ? `\n\nPossible duplicates:\n${result.duplicates.map((memory) => `- ${memory.title}: ${memory.body}`).join("\n")}`
      : "";
    return textResult(`${suffix}\n\n${result.memory.title}: ${result.memory.body}${duplicateText}`);
  }

  if (name === "propose_memory") {
    const result = store.createMemory({ ...scopedArgs, status: "proposed" }, { status: "proposed" });
    return textResult(`Memory proposal saved.\n\n${result.memory.title}: ${result.memory.body}`);
  }

  if (name === "update_memory") {
    const memory = store.updateMemory(scopedArgs.memory_id, scopedArgs.patch || {}, scopedArgs.agent_id || DEFAULT_AGENT_ID);
    return textResult(`Memory updated.\n\n${memory.title}: ${memory.body}`);
  }

  if (name === "delete_memory") {
    const memory = store.deleteMemory(scopedArgs.memory_id, scopedArgs.agent_id || DEFAULT_AGENT_ID);
    return textResult(`Memory deleted.\n\n${memory.title}`);
  }

  if (name === "verify_memory") {
    const memory = store.verifyMemory(scopedArgs.memory_id, scopedArgs.result, scopedArgs.note || "", scopedArgs.agent_id || DEFAULT_AGENT_ID);
    return textResult(`Memory verification recorded.\n\n${memory.title}`);
  }

  if (name === "list_proposals") {
    const proposals = listVisibleProposals(store, scopedArgs, role);
    return textResult(formatRecall(proposals, "Pending Memory Proposals"));
  }

  if (name === "approve_proposal") {
    const memory = store.approveProposal(
      scopedArgs.memory_id,
      scopedArgs.action || "approve",
      scopedArgs.patch || {},
      scopedArgs.agent_id || DEFAULT_AGENT_ID
    );
    return textResult(`Proposal ${scopedArgs.action === "reject" ? "rejected" : "approved"}.\n\n${memory.title}: ${memory.body}`);
  }

  if (name === "resolve_conflict") {
    const memories = store.resolveConflict(scopedArgs);
    return textResult(formatRecall(memories, "Conflict Resolution Applied"));
  }

  throw new Error(`Unknown tool: ${name}`);
}

function toolsForRole(role) {
  if (role === "admin") return tools;
  return tools.filter((tool) => !ADMIN_TOOL_NAMES.has(tool.name));
}

function scopeAgentArgs(args = {}, context = {}) {
  if (context.role === "agent" && context.agentId) {
    return { ...args, agent_id: context.agentId };
  }
  return args;
}

function visibleResourceMemories(store, context = {}) {
  const role = context.role || "agent";
  return store._listAll({})
    .filter((memory) => memory.status !== "deleted")
    .filter((memory) => {
      if (role === "admin") return true;
      if (memory.visibility === "common") return true;
      return context.agentId && memory.agent_id === context.agentId;
    });
}

function listVisibleProposals(store, args = {}, role = "agent") {
  const agentId = args.agent_id || DEFAULT_AGENT_ID;
  return store._listAll({ status: "proposed", agent_id: role === "admin" ? "" : agentId })
    .filter((memory) => {
      if (role === "admin") return true;
      if (memory.visibility === "common") return true;
      return memory.visibility === "agent_private" && memory.agent_id === agentId;
    });
}

function textResult(text) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

function formatConflict(result) {
  return [
    "Potential conflicting memories found. Resolve before saving.",
    "",
    `Candidate: ${result.candidate.title}: ${result.candidate.body}`,
    "",
    "Conflicts:",
    ...result.conflicts.map((memory) => `- ${memory.title}: ${memory.body}`)
  ].join("\n");
}

function memoryInputSchema() {
  return {
    type: "object",
    required: ["agent_id", "title", "body", "category"],
    properties: {
      agent_id: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      category: { type: "string" },
      visibility: { type: "string", enum: ["common", "agent_private"] },
      scope: { type: "string" },
      project_key: { type: "string" },
      applies_to: { type: "array", items: { type: "string" } },
      priority: { type: "string" },
      confidence: { type: "string" },
      tags: { type: "array", items: { type: "string" } }
    }
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
