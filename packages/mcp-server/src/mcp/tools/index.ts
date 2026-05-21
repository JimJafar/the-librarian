// Tool registry — collects every per-tool definition under `./` into
// the array `tools` and the lookup `toolsByName`. New tools added here
// become callable by `dispatch.ts` automatically.

import type { ToolDefinition } from "../tool.js";
import approveProposal from "./approve-proposal.js";
import archiveMemory from "./archive-memory.js";
import attachSession from "./attach-session.js";
import checkpointSession from "./checkpoint-session.js";
import continueSession from "./continue-session.js";
import endSession from "./end-session.js";
import getSession from "./get-session.js";
import listProposals from "./list-proposals.js";
import listSessionEvents from "./list-session-events.js";
import listSessions from "./list-sessions.js";
import pauseSession from "./pause-session.js";
import promoteSessionFact from "./promote-session-fact.js";
import proposeMemory from "./propose-memory.js";
import purgeSession from "./purge-session.js";
import recall from "./recall.js";
import recordSessionEvent from "./record-session-event.js";
import remember from "./remember.js";
import searchSessions from "./search-sessions.js";
import startContext from "./start-context.js";
import startSession from "./start-session.js";
import updateMemory from "./update-memory.js";
import verifyMemory from "./verify-memory.js";

export const tools: ToolDefinition[] = [
  startContext,
  recall,
  remember,
  proposeMemory,
  updateMemory,
  archiveMemory,
  verifyMemory,
  listProposals,
  approveProposal,
  startSession,
  getSession,
  listSessions,
  listSessionEvents,
  searchSessions,
  recordSessionEvent,
  checkpointSession,
  pauseSession,
  endSession,
  attachSession,
  continueSession,
  promoteSessionFact,
  purgeSession,
];

export const toolsByName: Map<string, ToolDefinition> = new Map(
  tools.map((tool) => [tool.name, tool]),
);
