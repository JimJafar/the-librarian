// `session_manifest` MCP tool (plan 036 Phase 5 / spec 035 §F6 server-side
// criterion). The session-start client hook (a separate spec) consumes this:
// the working-style preamble + a bounded skills manifest (name + description).
//
// Working-style source: the `working_style` setting (prose authored via the
// dashboard later) — a small, reversible choice. The skills manifest is the
// vault-derived list (already bounded to slug + name + description per entry).

import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

/** Read working_style fail-soft: this fires every session, so never let a
 * settings read (e.g. a secret-stored value with no master key) break it. */
function readWorkingStyle(store: Parameters<ToolDefinition["handler"]>[0]): string {
  try {
    return store.getSetting("working_style") ?? "";
  } catch {
    return "";
  }
}

const sessionManifest: ToolDefinition = {
  name: "session_manifest",
  description:
    "Return the session-start manifest: the working-style preamble and a " +
    "bounded list of available skills (slug, name, description).",
  inputSchema: { type: "object", properties: {} },
  handler(store) {
    return textResult(
      JSON.stringify(
        { workingStyle: readWorkingStyle(store), skills: store.skills.listSkills() },
        null,
        2,
      ),
    );
  },
};

export default sessionManifest;
