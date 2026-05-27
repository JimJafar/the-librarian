// CLI conv_id helpers — T5.3 of the memory-domain-isolation rollout.
//
// The CLI is mostly one-shot, but we accept an opt-in `--conv-id` flag
// (or the `LIBRARIAN_CONV_ID` env var) so an operator can stitch a
// series of CLI invocations into one conceptual conversation. When a
// matching `conversation_state` row exists, commands like `sessions
// start` inherit the domain from it.
//
// When neither flag nor env var is set, we deliberately do NOT
// auto-generate an id. The store-level fast path (single-domain
// installs default to `general`; multi-domain installs need an
// explicit domain) does the right thing without a synthetic conv-id
// polluting the registry.

import type { LibrarianStore } from "@librarian/core";
import { type FlagMap, flagString } from "../parse-flags.js";

export function resolveCliConvId(flags: FlagMap): string | null {
  const fromFlag = flagString(flags["conv-id"]);
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.LIBRARIAN_CONV_ID;
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

export function resolveCliDomain(store: LibrarianStore, convId: string | null): string | null {
  if (convId) {
    const state = store.convState.get(convId);
    if (state) return state.domain;
  }
  const rows = store.db.prepare("SELECT name FROM domains LIMIT 2").all() as Array<{
    name: string;
  }>;
  if (rows.length === 1) return rows[0]?.name ?? null;
  return null;
}
