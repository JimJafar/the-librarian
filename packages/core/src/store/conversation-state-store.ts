// Conversation-state store — owns the per-conversation runtime registry
// from memory-domain-isolation §4.8.
//
// The registry is a small key/value surface on top of the
// `conversation_state` SQLite table (introduced in T1.1). Each row is
// keyed by the harness-supplied `conv_id` and carries the attached
// `session_id` and `off_record` flag. Hook code in PR 5 will fetch via
// `get` on every turn; `upsert` lands on session start / resume; `clear`
// runs on explicit conv-id teardown. (D16 dropped the `domain` field.)
//
// All three operations are atomic per call (single prepared-statement
// execution).

import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../constants.js";
import {
  type ConversationState,
  type ConversationStatePatch,
  ConversationStatePatchSchema,
} from "../schemas/conversation-state.js";

export interface ConversationStateStoreDeps {
  db: DatabaseSync;
}

export interface ConversationStateStore {
  get(convId: string): ConversationState | null;
  upsert(convId: string, patch: ConversationStatePatch): ConversationState;
  clear(convId: string): void;
}

interface ConversationStateRow {
  conv_id: string;
  harness: string;
  session_id: string | null;
  off_record: number;
  created_at: string;
  updated_at: string;
}

function rowToState(row: ConversationStateRow): ConversationState {
  return {
    conv_id: row.conv_id,
    harness: row.harness,
    session_id: row.session_id,
    off_record: Boolean(row.off_record),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createConversationStateStore(
  deps: ConversationStateStoreDeps,
): ConversationStateStore {
  const { db } = deps;

  function assertConvId(convId: string): void {
    if (typeof convId !== "string" || convId.length === 0) {
      throw new Error("conv_state: conv_id must be a non-empty string.");
    }
  }

  function get(convId: string): ConversationState | null {
    assertConvId(convId);
    const row = db.prepare("SELECT * FROM conversation_state WHERE conv_id = ?").get(convId) as
      | ConversationStateRow
      | undefined;
    return row ? rowToState(row) : null;
  }

  function upsert(convId: string, patch: ConversationStatePatch): ConversationState {
    assertConvId(convId);
    // Validate at the boundary — every caller (MCP handler, future
    // HTTP routes, hook code) gets one canonical shape check.
    const parsed = ConversationStatePatchSchema.parse(patch);
    const existing = get(convId);
    const now = nowIso();
    if (existing) {
      const next: ConversationState = {
        ...existing,
        harness: parsed.harness ?? existing.harness,
        session_id: parsed.session_id === undefined ? existing.session_id : parsed.session_id,
        off_record: parsed.off_record ?? existing.off_record,
        updated_at: now,
      };
      db.prepare(
        `UPDATE conversation_state
            SET harness = ?, session_id = ?, off_record = ?, updated_at = ?
          WHERE conv_id = ?`,
      ).run(next.harness, next.session_id, next.off_record ? 1 : 0, next.updated_at, convId);
      return next;
    }

    if (!parsed.harness) {
      throw new Error(
        "conv_state.upsert: first-create requires `harness` (it maps to a NOT NULL column).",
      );
    }
    const next: ConversationState = {
      conv_id: convId,
      harness: parsed.harness,
      session_id: parsed.session_id ?? null,
      off_record: parsed.off_record ?? false,
      created_at: now,
      updated_at: now,
    };
    db.prepare(
      `INSERT INTO conversation_state (
        conv_id, harness, session_id, off_record, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      next.conv_id,
      next.harness,
      next.session_id,
      next.off_record ? 1 : 0,
      next.created_at,
      next.updated_at,
    );
    return next;
  }

  function clear(convId: string): void {
    assertConvId(convId);
    db.prepare("DELETE FROM conversation_state WHERE conv_id = ?").run(convId);
  }

  return { get, upsert, clear };
}
