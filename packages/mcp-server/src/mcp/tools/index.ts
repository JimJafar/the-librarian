// Tool registry — collects every per-tool definition under `./` into
// the array `tools` and the lookup `toolsByName`. New tools added here
// become callable by `dispatch.ts` automatically.

import type { ToolDefinition } from "../tool.js";
import approveProposal from "./approve-proposal.js";
import archiveMemory from "./archive-memory.js";
import claimHandoff from "./claim-handoff.js";
import convStateClear from "./conv-state-clear.js";
import convStateGet from "./conv-state-get.js";
import convStateUpsert from "./conv-state-upsert.js";
import listHandoffs from "./list-handoffs.js";
import listProposals from "./list-proposals.js";
import proposeMemory from "./propose-memory.js";
import recall from "./recall.js";
import remember from "./remember.js";
import startContext from "./start-context.js";
import storeHandoff from "./store-handoff.js";
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
  convStateGet,
  convStateUpsert,
  convStateClear,
  storeHandoff,
  listHandoffs,
  claimHandoff,
];

export const toolsByName: Map<string, ToolDefinition> = new Map(
  tools.map((tool) => [tool.name, tool]),
);
