import { DEFAULT_AGENT_ID, formatRecall, SESSION_PAYLOAD_TYPES } from "@librarian/core";

export const tools = [
  {
    name: "start_context",
    description: "Return required clean prose context for an agent at task start.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        project_key: { type: "string" },
        task_summary: { type: "string" },
      },
    },
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
        limit: { type: "number" },
      },
    },
  },
  {
    name: "remember",
    description: "Save a durable memory. Protected categories become proposals.",
    inputSchema: memoryInputSchema(),
  },
  {
    name: "propose_memory",
    description: "Create a proposed memory for review.",
    inputSchema: memoryInputSchema(),
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
        patch: { type: "object" },
      },
    },
  },
  {
    name: "delete_memory",
    description: "Tombstone a memory.",
    inputSchema: {
      type: "object",
      required: ["memory_id"],
      properties: {
        agent_id: { type: "string" },
        memory_id: { type: "string" },
      },
    },
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
        note: { type: "string" },
      },
    },
  },
  {
    name: "list_proposals",
    description: "List pending proposed memories.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
      },
    },
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
        patch: { type: "object" },
      },
    },
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
        patch: { type: "object" },
      },
    },
  },
  {
    name: "start_session",
    description: "Start a new Librarian session, attributed to the calling agent.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        project_key: { type: "string" },
        visibility: { type: "string", enum: ["common", "agent_private"] },
        harness: { type: "string" },
        source_ref: { type: "string" },
        cwd: { type: "string" },
        capture_mode: { type: "string", enum: ["off", "summary", "log"] },
        start_summary: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        next_steps: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "get_session",
    description: "Return the full session record for the given session_id (subject to visibility).",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string" },
      },
    },
  },
  {
    name: "list_sessions",
    description: "Return selectable sessions ranked for resume. Never auto-selects.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        source_ref: { type: "string" },
        cwd: { type: "string" },
        harness: { type: "string" },
        status: { type: "array", items: { type: "string" } },
        include_archived: { type: "boolean" },
        include_deleted: { type: "boolean" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "list_session_events",
    description: "Return the event stream for a session, paginated and optionally type-filtered.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string" },
        type: { type: "string", enum: SESSION_PAYLOAD_TYPES },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
  },
  {
    name: "search_sessions",
    description: "Search session summaries and events. Archived/deleted excluded by default.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        project_key: { type: "string" },
        include_archived: { type: "boolean" },
        include_deleted: { type: "boolean" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "record_session_event",
    description:
      "Record a typed evidence event on a visible session. Implicitly resumes a paused session.",
    inputSchema: {
      type: "object",
      required: ["session_id", "type", "summary"],
      properties: {
        session_id: { type: "string" },
        type: { type: "string", enum: SESSION_PAYLOAD_TYPES },
        summary: { type: "string" },
        payload: { type: "object" },
        harness: { type: "string" },
        source_ref: { type: "string" },
      },
    },
  },
  {
    name: "checkpoint_session",
    description: "Update the rolling summary, decisions, and next steps. Keeps the session active.",
    inputSchema: sessionLifecycleSchema(),
  },
  {
    name: "pause_session",
    description:
      "Mark the session paused and store a pause summary. Activity resumes it implicitly.",
    inputSchema: sessionLifecycleSchema(),
  },
  {
    name: "end_session",
    description:
      "Mark the session ended. Writes end_summary; rolling_summary is frozen at the last checkpoint.",
    inputSchema: {
      ...sessionLifecycleSchema(),
      properties: {
        ...sessionLifecycleSchema().properties,
        candidate_memories: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    name: "attach_session",
    description:
      "Record attachment of a session to the calling harness/source without generating a handover.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string" },
        harness: { type: "string" },
        source_ref: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "continue_session",
    description:
      "Generate a handover package for the session and (by default) attach to the target harness.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string" },
        target_harness: { type: "string" },
        target_source_ref: { type: "string" },
        target_cwd: { type: "string" },
        attach: { type: "boolean" },
        format: {
          type: "string",
          enum: ["prose", "markdown", "claude", "codex", "opencode", "hermes", "pi"],
        },
      },
    },
  },
  {
    name: "archive_session",
    description:
      "Hide a session from default lists while keeping it searchable via include_archived.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "restore_session",
    description:
      "Restore an archived or soft-deleted session to its prior status. Owner-or-admin only.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string" },
      },
    },
  },
  {
    name: "delete_session",
    description:
      "Soft-delete a session. Owner may delete their own sessions; admin may delete any.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "promote_session_fact",
    description:
      "Promote a fact from a visible session into a durable memory (or proposal for protected categories).",
    inputSchema: {
      type: "object",
      required: ["session_id", "memory"],
      properties: {
        session_id: { type: "string" },
        session_event_id: { type: "string" },
        memory: { type: "object" },
      },
    },
  },
];

const ADMIN_TOOL_NAMES = new Set(["approve_proposal", "delete_memory", "resolve_conflict"]);

export async function dispatchMcp(store, method, params = {}, context = {}) {
  const role = context.role || "agent";
  if (method === "initialize") {
    return {
      protocolVersion: params.protocolVersion || "2025-06-18",
      capabilities: {
        tools: {},
        resources: {},
      },
      serverInfo: {
        name: "the-librarian",
        version: "0.1.0",
      },
    };
  }

  if (method === "tools/list") return { tools: toolsForRole(role) };
  if (method === "tools/call") return callTool(store, params.name, params.arguments || {}, context);
  if (method === "resources/list") {
    const description =
      role === "admin"
        ? "Human-readable memory snapshot."
        : "Human-readable common memory snapshot.";
    return {
      resources: [
        {
          uri: "librarian://memories",
          name: "The Librarian Memories",
          description,
          mimeType: "text/markdown",
        },
      ],
    };
  }
  if (method === "resources/read" && params.uri === "librarian://memories") {
    const memories = visibleResourceMemories(store, context);
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
    const suffix =
      result.status === "proposed"
        ? "This memory is protected and has been saved as a proposal for review."
        : "Memory saved.";
    const duplicateText = result.duplicates?.length
      ? `\n\nPossible duplicates:\n${result.duplicates.map((memory) => `- ${memory.title}: ${memory.body}`).join("\n")}`
      : "";
    return textResult(`${suffix}\n\n${result.memory.title}: ${result.memory.body}${duplicateText}`);
  }

  if (name === "propose_memory") {
    const result = store.createMemory(
      { ...scopedArgs, status: "proposed" },
      { status: "proposed" },
    );
    return textResult(`Memory proposal saved.\n\n${result.memory.title}: ${result.memory.body}`);
  }

  if (name === "update_memory") {
    const memory = store.updateMemory(
      scopedArgs.memory_id,
      scopedArgs.patch || {},
      scopedArgs.agent_id || DEFAULT_AGENT_ID,
    );
    return textResult(`Memory updated.\n\n${memory.title}: ${memory.body}`);
  }

  if (name === "delete_memory") {
    const memory = store.deleteMemory(
      scopedArgs.memory_id,
      scopedArgs.agent_id || DEFAULT_AGENT_ID,
    );
    return textResult(`Memory deleted.\n\n${memory.title}`);
  }

  if (name === "verify_memory") {
    const memory = store.verifyMemory(
      scopedArgs.memory_id,
      scopedArgs.result,
      scopedArgs.note || "",
      scopedArgs.agent_id || DEFAULT_AGENT_ID,
    );
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
      scopedArgs.agent_id || DEFAULT_AGENT_ID,
    );
    return textResult(
      `Proposal ${scopedArgs.action === "reject" ? "rejected" : "approved"}.\n\n${memory.title}: ${memory.body}`,
    );
  }

  if (name === "resolve_conflict") {
    const memories = store.resolveConflict(scopedArgs);
    return textResult(formatRecall(memories, "Conflict Resolution Applied"));
  }

  if (name === "start_session") {
    const result = store.startSession(scopedArgs);
    return textResult(formatSessionStart(result.session));
  }

  if (name === "get_session") {
    const session = store.getSession(scopedArgs.session_id);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scopedArgs.session_id}.`);
    }
    return textResult(formatSessionDetail(session));
  }

  if (name === "list_sessions") {
    const result = store.listSessions(scopedArgs);
    return textResult(formatSessionList(result));
  }

  if (name === "list_session_events") {
    const session = store.getSession(scopedArgs.session_id);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scopedArgs.session_id}.`);
    }
    const result = store.listSessionEvents(scopedArgs);
    return textResult(formatSessionEvents(result, session));
  }

  if (name === "search_sessions") {
    const result = store.searchSessions(scopedArgs);
    return textResult(formatSessionSearch(result));
  }

  if (
    name === "record_session_event" ||
    name === "checkpoint_session" ||
    name === "pause_session" ||
    name === "end_session" ||
    name === "attach_session" ||
    name === "continue_session"
  ) {
    const session = store.getSession(scopedArgs.session_id);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scopedArgs.session_id}.`);
    }
    if (name === "record_session_event") {
      store.recordSessionEvent(scopedArgs);
      return textResult(`Recorded ${scopedArgs.type} on session ${scopedArgs.session_id}.`);
    }
    if (name === "checkpoint_session") {
      const result = store.checkpointSession(scopedArgs);
      return textResult(formatSessionLifecycle(result.session, "Checkpoint recorded."));
    }
    if (name === "pause_session") {
      const result = store.pauseSession(scopedArgs);
      return textResult(formatSessionLifecycle(result.session, "Session paused."));
    }
    if (name === "end_session") {
      const result = store.endSession(scopedArgs);
      return textResult(formatSessionLifecycle(result.session, "Session ended."));
    }
    if (name === "attach_session") {
      const result = store.attachSession(scopedArgs);
      return textResult(
        formatSessionLifecycle(
          result.session,
          `Attached to ${result.session.current_harness || "(unspecified harness)"}.`,
        ),
      );
    }
    if (name === "continue_session") {
      const result = store.continueSession(scopedArgs);
      return textResult(result.text);
    }
  }

  if (name === "promote_session_fact") {
    const session = store.getSession(scopedArgs.session_id);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scopedArgs.session_id}.`);
    }
    const result = store.promoteSessionFact(scopedArgs);
    if (result.status === "conflict") {
      return textResult(formatPromotionConflict(result));
    }
    const headline =
      result.status === "proposed"
        ? "Promoted to memory proposal (awaiting review)."
        : "Promoted to active memory.";
    return textResult(`${headline}\n\n${result.memory.title}: ${result.memory.body}`);
  }

  if (name === "archive_session" || name === "restore_session" || name === "delete_session") {
    const session = store.getSession(scopedArgs.session_id);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scopedArgs.session_id}.`);
    }
    if (name === "archive_session") {
      const result = store.archiveSession(scopedArgs);
      return textResult(formatSessionLifecycle(result.session, "Session archived."));
    }
    if (name === "restore_session") {
      const result = store.restoreSession(scopedArgs);
      return textResult(
        formatSessionLifecycle(result.session, `Session restored to ${result.session.status}.`),
      );
    }
    if (name === "delete_session") {
      const result = store.deleteSession(scopedArgs);
      return textResult(formatSessionLifecycle(result.session, "Session deleted."));
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

function toolsForRole(role) {
  if (role === "admin") return tools;
  return tools.filter((tool) => !ADMIN_TOOL_NAMES.has(tool.name));
}

function scopeAgentArgs(args = {}, context = {}) {
  const scoped = { ...args };
  delete scoped.admin;
  if (context.role === "admin") {
    scoped.admin = true;
  } else if (context.role === "agent" && context.agentId) {
    scoped.agent_id = context.agentId;
  }
  return scoped;
}

function isSessionVisible(session, context = {}) {
  if (!session) return false;
  if (context.role === "admin") return true;
  if (session.visibility === "common") return true;
  if (
    context.role === "agent" &&
    context.agentId &&
    session.created_by_agent_id === context.agentId
  ) {
    return true;
  }
  return false;
}

function visibleResourceMemories(store, context = {}) {
  const role = context.role || "agent";
  return store
    ._listAll({})
    .filter((memory) => memory.status !== "deleted")
    .filter((memory) => {
      if (role === "admin") return true;
      if (memory.visibility === "common") return true;
      return context.agentId && memory.agent_id === context.agentId;
    });
}

function listVisibleProposals(store, args = {}, role = "agent") {
  const agentId = args.agent_id || DEFAULT_AGENT_ID;
  return store
    ._listAll({ status: "proposed", agent_id: role === "admin" ? "" : agentId })
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
        text,
      },
    ],
  };
}

function formatConflict(result) {
  return [
    "Potential conflicting memories found. Resolve before saving.",
    "",
    `Candidate: ${result.candidate.title}: ${result.candidate.body}`,
    "",
    "Conflicts:",
    ...result.conflicts.map((memory) => `- ${memory.title}: ${memory.body}`),
  ].join("\n");
}

export function formatSessionStart(session) {
  const lines = [
    "Session started.",
    "",
    `Title: ${session.title}`,
    `ID: ${session.id}`,
    `Status: ${session.status}`,
    `Visibility: ${session.visibility}`,
    `Project: ${session.project_key || "(none)"}`,
    `Harness: ${session.current_harness || "(unattached)"}`,
  ];
  if (session.start_summary) {
    lines.push("", `Goal: ${session.start_summary}`);
  }
  lines.push("", "Use this session_id with checkpoint/pause/end/record calls.");
  return lines.join("\n");
}

export function formatSessionDetail(session) {
  const lines = [
    `Session: ${session.title}`,
    `ID: ${session.id}`,
    `Status: ${session.status}`,
    `Visibility: ${session.visibility}`,
    `Project: ${session.project_key || "(none)"}`,
    `Created by: ${session.created_by_agent_id || "(unknown)"} in ${session.created_in_harness || "(unknown)"}`,
    `Current: ${session.current_agent_id || "(unattached)"} in ${session.current_harness || "(unattached)"}`,
    session.source_ref ? `Source: ${session.source_ref}` : null,
    session.cwd ? `Cwd: ${session.cwd}` : null,
    `Started: ${session.started_at}`,
    `Last activity: ${session.last_activity_at}`,
  ].filter(Boolean);
  if (session.start_summary) lines.push("", `Goal: ${session.start_summary}`);
  if (session.rolling_summary) lines.push("", `Current summary: ${session.rolling_summary}`);
  if (session.end_summary) lines.push("", `End summary: ${session.end_summary}`);
  if (session.next_steps?.length) {
    lines.push("", "Next steps:", ...session.next_steps.map((step) => `- ${step}`));
  }
  if (session.tags?.length) {
    lines.push("", `Tags: ${session.tags.join(", ")}`);
  }
  return lines.join("\n");
}

export function formatSessionList(result) {
  if (!result.sessions.length) {
    return "No resumable sessions found.";
  }
  const lines = [`Resumable sessions (${result.sessions.length} of ${result.total}):`, ""];
  result.sessions.forEach((session, index) => {
    const idx = index + 1;
    const project = session.project_key || "no project";
    const harness = session.current_harness || "(unattached)";
    const last = session.last_activity_at || "(unknown)";
    lines.push(
      `${idx}. [${session.status}] ${session.title} — ${project} — ${harness} — last: ${last}`,
    );
    if (session.next_steps?.length) {
      lines.push(`   next: ${session.next_steps[0]}`);
    }
    lines.push(`   id: ${session.id}`);
  });
  lines.push("");
  lines.push("Pass the canonical session_id to resume/checkpoint/end calls.");
  return lines.join("\n");
}

export function formatSessionEvents(result, session) {
  if (!result.events.length) {
    return `No events found for session ${session?.id || ""}.`;
  }
  const header = session
    ? `Session events for "${session.title}" (${result.events.length} of ${result.total}):`
    : `Session events (${result.events.length} of ${result.total}):`;
  const lines = [header, ""];
  result.events.forEach((event, index) => {
    const summary = event.summary || "(no summary)";
    const who = event.agent_id ? ` — ${event.agent_id}` : "";
    lines.push(`${index + 1}. [${event.type}]${who} — ${summary}`);
  });
  return lines.join("\n");
}

export function formatSessionSearch(result) {
  if (!result.sessions.length) {
    return "No sessions matched your search.";
  }
  const lines = [`Matching sessions (${result.sessions.length} of ${result.total}):`, ""];
  result.sessions.forEach((session, index) => {
    const project = session.project_key || "no project";
    lines.push(
      `${index + 1}. [${session.status}] ${session.title} — ${project} — id: ${session.id}`,
    );
  });
  return lines.join("\n");
}

function formatPromotionConflict(result) {
  return [
    "Promotion blocked by conflicting memories.",
    "",
    `Candidate: ${result.candidate.title}: ${result.candidate.body}`,
    "",
    "Conflicts:",
    ...result.conflicts.map((memory) => `- ${memory.title}: ${memory.body}`),
  ].join("\n");
}

export function formatSessionLifecycle(session, headline) {
  const lines = [
    headline,
    "",
    `Session: ${session.title}`,
    `ID: ${session.id}`,
    `Status: ${session.status}`,
  ];
  if (session.rolling_summary) lines.push(`Rolling summary: ${session.rolling_summary}`);
  if (session.end_summary) lines.push(`End summary: ${session.end_summary}`);
  if (session.next_steps?.length) {
    lines.push("", "Next steps:", ...session.next_steps.map((step) => `- ${step}`));
  }
  return lines.join("\n");
}

function sessionLifecycleSchema() {
  return {
    type: "object",
    required: ["session_id", "summary"],
    properties: {
      session_id: { type: "string" },
      summary: { type: "string" },
      decisions: { type: "array", items: { type: "string" } },
      files_touched: { type: "array", items: { type: "string" } },
      commands_run: { type: "array", items: { type: "string" } },
      open_questions: { type: "array", items: { type: "string" } },
      next_steps: { type: "array", items: { type: "string" } },
      harness: { type: "string" },
      source_ref: { type: "string" },
    },
  };
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
      tags: { type: "array", items: { type: "string" } },
    },
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
