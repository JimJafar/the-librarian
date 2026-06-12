// Tool registry — collects every per-tool definition under `./` into
// the array `tools` and the lookup `toolsByName`. New tools added here
// become callable by `dispatch.ts` automatically.

import type { ToolDefinition } from "../tool.js";
import claimHandoff from "./claim-handoff.js";
import convStateClear from "./conv-state-clear.js";
import convStateGet from "./conv-state-get.js";
import convStateUpsert from "./conv-state-upsert.js";
import flagMemory from "./flag-memory.js";
import getSkill from "./get-skill.js";
import listHandoffs from "./list-handoffs.js";
import listSkills from "./list-skills.js";
import recall from "./recall.js";
import remember from "./remember.js";
import searchReferences from "./search-references.js";
import storeHandoff from "./store-handoff.js";

export const tools: ToolDefinition[] = [
  recall,
  remember,
  flagMemory,
  convStateGet,
  convStateUpsert,
  convStateClear,
  storeHandoff,
  listHandoffs,
  claimHandoff,
  listSkills,
  getSkill,
  searchReferences,
];

export const toolsByName: Map<string, ToolDefinition> = new Map(
  tools.map((tool) => [tool.name, tool]),
);
