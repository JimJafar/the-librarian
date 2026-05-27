// Conversation-state store — owns the per-conversation runtime registry
// from memory-domain-isolation §4.8.
//
// The registry is a small key/value surface on top of the
// `conversation_state` SQLite table (introduced in T1.1). Each row is
// keyed by the harness-supplied `conv_id` and carries the current
// `domain`, attached `session_id`, and `off_record` flag. Hook code in
// PR 5 will fetch via `get` on every turn; `upsert` lands on session
// start / resume; `clear` runs on explicit conv-id teardown.
//
// All three operations are atomic per call (single prepared-statement
// execution).

import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../constants.js";
import type { ConversationState, ConversationStatePatch } from "../schemas/conversation-state.js";

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
  domain: string;
  session_id: string | null;
  off_record: number;
  created_at: string;
  updated_at: string;
}

function rowToState(row: ConversationStateRow): ConversationState {
  return {
    conv_id: row.conv_id,
    harness: row.harness,
    domain: row.domain,
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

  function get(convId: string): ConversationState | null {
    const row = db.prepare("SELECT * FROM conversation_state WHERE conv_id = ?").get(convId) as
      | ConversationStateRow
      | undefined;
    return row ? rowToState(row) : null;
  }

  function upsert(convId: string, patch: ConversationStatePatch): ConversationState {
    const existing = get(convId);
    const now = nowIso();
    if (existing) {
      const next: ConversationState = {
        ...existing,
        harness: patch.harness ?? existing.harness,
        domain: patch.domain ?? existing.domain,
        session_id: patch.session_id === undefined ? existing.session_id : patch.session_id,
        off_record: patch.off_record ?? existing.off_record,
        updated_at: now,
      };
      db.prepare(
        `UPDATE conversation_state
            SET harness = ?, domain = ?, session_id = ?, off_record = ?, updated_at = ?
          WHERE conv_id = ?`,
      ).run(
        next.harness,
        next.domain,
        next.session_id,
        next.off_record ? 1 : 0,
        next.updated_at,
        convId,
      );
      return next;
    }

    if (!patch.harness || !patch.domain) {
      throw new Error(
        "conv_state.upsert: first-create requires both `harness` and `domain` " +
          "(they map to NOT NULL columns).",
      );
    }
    const next: ConversationState = {
      conv_id: convId,
      harness: patch.harness,
      domain: patch.domain,
      session_id: patch.session_id ?? null,
      off_record: patch.off_record ?? false,
      created_at: now,
      updated_at: now,
    };
    db.prepare(
      `INSERT INTO conversation_state (
        conv_id, harness, domain, session_id, off_record, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      next.conv_id,
      next.harness,
      next.domain,
      next.session_id,
      next.off_record ? 1 : 0,
      next.created_at,
      next.updated_at,
    );
    return next;
  }

  function clear(convId: string): void {
    db.prepare("DELETE FROM conversation_state WHERE conv_id = ?").run(convId);
  }

  return { get, upsert, clear };
}
