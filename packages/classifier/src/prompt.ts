// Prompt rendering — fills the `{{title}}` / `{{body}}` / `{{tags}}`
// placeholders in the inlined v<N> template.
//
// The version string (e.g. `"v1"`) is the spec's identity per §4.4. The
// English source of truth lives in `src/prompts/v<N>.md` for human
// review; `src/prompts/v<N>.ts` is what compiles into the bundle.

import { PROMPT_V1 } from "./prompts/v1.js";
import type { ClassifyInput } from "./types.js";

const TEMPLATES: Record<string, string> = {
  v1: PROMPT_V1,
};

export function loadPromptTemplate(version: string): string {
  const template = TEMPLATES[version];
  if (template === undefined) {
    throw new Error(`Unknown classifier prompt version: ${version}`);
  }
  return template;
}

/**
 * Render the prompt template with the memory's fields substituted in.
 * Tags are joined by `, ` for readability; the model isn't sensitive to
 * the exact tag formatting at this template position.
 */
export function renderPrompt(template: string, input: ClassifyInput): string {
  return template
    .replace("{{title}}", input.title)
    .replace("{{body}}", input.body)
    .replace("{{tags}}", input.tags.join(", "));
}
