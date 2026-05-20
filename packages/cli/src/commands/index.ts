// Session verb registry.
//
// Each entry is a `Command` — a thin wrapper around the store call
// for that verb. runtime.ts dispatches by looking the verb up here,
// which keeps the dispatch table flat and the per-verb files
// independently reviewable.

import type { Command } from "./_shared.js";
import { archive } from "./archive.js";
import { attach } from "./attach.js";
import { checkpoint } from "./checkpoint.js";
import { continueCommand } from "./continue.js";
import { deleteCommand } from "./delete.js";
import { end } from "./end.js";
import { events } from "./events.js";
import { list } from "./list.js";
import { pause } from "./pause.js";
import { restore } from "./restore.js";
import { search } from "./search.js";
import { show } from "./show.js";
import { start } from "./start.js";

export const sessionVerbs: Record<string, Command> = {
  start,
  list,
  show,
  checkpoint,
  pause,
  end,
  attach,
  continue: continueCommand,
  archive,
  restore,
  delete: deleteCommand,
  search,
  events,
};

export type { Command } from "./_shared.js";
