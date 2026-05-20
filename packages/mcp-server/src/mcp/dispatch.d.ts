// Ambient declarations for the JS dispatch module. Replaced wholesale
// when T4.2 ports `dispatch.js` to TS.

import type { LibrarianStore } from "@librarian/core";

export interface DispatchContext {
  role?: "admin" | "agent" | undefined;
  agentId?: string | undefined;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export const tools: McpTool[];

export function dispatchMcp(
  store: LibrarianStore,
  method: string,
  params?: Record<string, unknown>,
  context?: DispatchContext,
): Promise<unknown>;

export function handleMcpMessage(
  store: LibrarianStore,
  message: Record<string, unknown>,
  context?: DispatchContext,
): Promise<Record<string, unknown> | null>;

export function handleMcpPayload(
  store: LibrarianStore,
  payload: Record<string, unknown> | Record<string, unknown>[],
  context?: DispatchContext,
): Promise<Record<string, unknown> | Record<string, unknown>[] | null>;

export function formatSessionStart(session: Record<string, unknown>): string;
export function formatSessionDetail(session: Record<string, unknown>): string;
export function formatSessionList(result: Record<string, unknown>): string;
export function formatSessionEvents(
  result: Record<string, unknown>,
  session: Record<string, unknown>,
): string;
export function formatSessionSearch(result: Record<string, unknown>): string;
export function formatSessionLifecycle(session: Record<string, unknown>, headline: string): string;
