// JSON conv-state store (plan 036 Phase 2). conv-state is ephemeral
// per-conversation runtime (harness, attached session, off-record gate) —
// NOT durable knowledge — so it lives on a sidecar JSON file OUTSIDE the git
// vault (decided 2026-06-01), keyed by conv_id. Same ConversationStateStore
// contract as the SQLite store; replaces it at the Phase-7 cutover.
//
// Sync (single map file, whole-file read/write per op — fine at the scale of
// a handful of live conversations).

import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../../constants.js";
import {
  type ConversationState,
  type ConversationStatePatch,
  ConversationStatePatchSchema,
} from "../../schemas/conversation-state.js";
import type { ConversationStateStore } from "../conversation-state-store.js";

export interface JsonConversationStateStoreDeps {
  /** Sidecar file path, outside the git vault (e.g. `<data-dir>/conv-state.json`). */
  filePath: string;
  now?: () => string;
}

export function createJsonConversationStateStore(
  deps: JsonConversationStateStoreDeps,
): ConversationStateStore {
  const { filePath } = deps;
  const now = deps.now ?? nowIso;

  function assertConvId(convId: string): void {
    if (typeof convId !== "string" || convId.length === 0) {
      throw new Error("conv_state: conv_id must be a non-empty string.");
    }
  }

  function readAll(): Record<string, ConversationState> {
    if (!fs.existsSync(filePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, ConversationState>)
        : {};
    } catch {
      return {}; // corrupt/empty file → start fresh (it's disposable runtime state)
    }
  }

  function writeAll(map: Record<string, ConversationState>): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  }

  function get(convId: string): ConversationState | null {
    assertConvId(convId);
    return readAll()[convId] ?? null;
  }

  function upsert(convId: string, patch: ConversationStatePatch): ConversationState {
    assertConvId(convId);
    // Validate at the boundary — one canonical shape check for every caller.
    const parsed = ConversationStatePatchSchema.parse(patch);
    const map = readAll();
    const existing = map[convId] ?? null;
    const ts = now();

    let next: ConversationState;
    if (existing) {
      next = {
        ...existing,
        harness: parsed.harness ?? existing.harness,
        session_id: parsed.session_id === undefined ? existing.session_id : parsed.session_id,
        off_record: parsed.off_record ?? existing.off_record,
        updated_at: ts,
      };
    } else {
      if (!parsed.harness) {
        throw new Error("conv_state.upsert: first-create requires `harness`.");
      }
      next = {
        conv_id: convId,
        harness: parsed.harness,
        session_id: parsed.session_id ?? null,
        off_record: parsed.off_record ?? false,
        created_at: ts,
        updated_at: ts,
      };
    }
    map[convId] = next;
    writeAll(map);
    return next;
  }

  function clear(convId: string): void {
    assertConvId(convId);
    const map = readAll();
    if (convId in map) {
      delete map[convId];
      writeAll(map);
    }
  }

  return { get, upsert, clear };
}
