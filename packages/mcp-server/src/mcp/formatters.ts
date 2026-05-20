// Session-shaped prose formatters used by MCP tool handlers and
// re-exported from `@librarian/mcp-server` for the CLI.
//
// Extracted from the pre-T4.2 dispatch.js. Output strings are
// byte-identical to the previous implementation — the MCP and CLI
// tests pin the wire format.

import type { Session } from "@librarian/core/store-internal";

interface SessionListResult {
  sessions: Session[];
  total: number;
}

interface SessionEventsResult {
  events: { type: string; agent_id?: string | null; summary?: string | null }[];
  total: number;
}

export function formatSessionStart(session: Session): string {
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

export function formatSessionDetail(session: Session): string {
  const lines = [
    `Session: ${session.title}`,
    `ID: ${session.id}`,
    `Status: ${session.status}`,
    `Visibility: ${session.visibility}`,
    `Project: ${session.project_key || "(none)"}`,
    `Created by: ${session.created_by_agent_id || "(unknown)"} in ${
      session.created_in_harness || "(unknown)"
    }`,
    `Current: ${session.current_agent_id || "(unattached)"} in ${
      session.current_harness || "(unattached)"
    }`,
    session.source_ref ? `Source: ${session.source_ref}` : null,
    session.cwd ? `Cwd: ${session.cwd}` : null,
    `Started: ${session.started_at}`,
    `Last activity: ${session.last_activity_at}`,
  ].filter((line): line is string => Boolean(line));
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

export function formatSessionList(result: SessionListResult): string {
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

export function formatSessionEvents(result: SessionEventsResult, session: Session | null): string {
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

export function formatSessionSearch(result: SessionListResult): string {
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

export function formatSessionLifecycle(session: Session, headline: string): string {
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
