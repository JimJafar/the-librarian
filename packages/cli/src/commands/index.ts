// Session verb registry.
//
// Each entry is a `Command` — a thin wrapper around the store call
// for that verb. runtime.ts dispatches by looking the verb up here,
// which keeps the dispatch table flat and the per-verb files
// independently reviewable.

import type { Command } from "./_shared.js";
import { attach } from "./attach.js";
import { checkpoint } from "./checkpoint.js";
import { continueCommand } from "./continue.js";
import { end } from "./end.js";
import { events } from "./events.js";
import { handoffsList } from "./handoffs-list.js";
import { handoffsPurge } from "./handoffs-purge.js";
import { handoffsShow } from "./handoffs-show.js";
import { list } from "./list.js";
import { pause } from "./pause.js";
import { search } from "./search.js";
import { show } from "./show.js";
import { start } from "./start.js";

// S1.1 retired the archive / restore / delete verbs — `end` covers all
// three intents, and `continue` works on ended sessions.
export const sessionVerbs: Record<string, Command> = {
  start,
  list,
  show,
  checkpoint,
  pause,
  end,
  attach,
  continue: continueCommand,
  search,
  events,
};

// sessions-rethink PR 1 — handoffs surface (additive). The `sessions`
// surface is removed in PR 7; until then the two live side-by-side.
export const handoffVerbs: Record<string, Command> = {
  list: handoffsList,
  show: handoffsShow,
  purge: handoffsPurge,
};

export type { Command } from "./_shared.js";
