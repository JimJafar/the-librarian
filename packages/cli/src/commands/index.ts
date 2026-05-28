// Command verb registry.
//
// sessions-rethink PR 7 — the `sessionVerbs` map is retired with the
// rest of the session subsystem. Only the handoffs surface (added in
// PR 1) is registered here.

import type { Command } from "./_shared.js";
import { handoffsList } from "./handoffs-list.js";
import { handoffsPurge } from "./handoffs-purge.js";
import { handoffsShow } from "./handoffs-show.js";

export const handoffVerbs: Record<string, Command> = {
  list: handoffsList,
  show: handoffsShow,
  purge: handoffsPurge,
};

export type { Command } from "./_shared.js";
