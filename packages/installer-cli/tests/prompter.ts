// A scriptable fake Prompter for orchestration tests — no TTY, no stdin.
//
// `selectHarnesses` returns a fixed id list (or "all available" by default);
// `promptText` returns scripted answers keyed by a substring of the question,
// so a test can answer the URL, the token, and the "remove env?" prompt
// distinctly without coupling to the exact wording.

import type { HarnessChoice, Prompter, PromptTextOptions } from "../src/prompt.js";

export interface FakePrompterScript {
  /** Ids `selectHarnesses` returns. `"all"` → every offered harness. */
  select?: string[] | "all";
  /** Answers keyed by a lowercase substring of the question. */
  answers?: Record<string, string>;
}

export class FakePrompter implements Prompter {
  readonly selectCalls: HarnessChoice[][] = [];
  readonly textCalls: { question: string; opts: PromptTextOptions }[] = [];

  constructor(private readonly script: FakePrompterScript = {}) {}

  async selectHarnesses(available: HarnessChoice[]): Promise<string[]> {
    this.selectCalls.push(available);
    const sel = this.script.select;
    if (sel === undefined || sel === "all") return available.map((h) => h.id);
    return available.filter((h) => sel.includes(h.id)).map((h) => h.id);
  }

  async promptText(question: string, opts: PromptTextOptions = {}): Promise<string> {
    this.textCalls.push({ question, opts });
    const lc = question.toLowerCase();
    for (const [needle, answer] of Object.entries(this.script.answers ?? {})) {
      if (lc.includes(needle.toLowerCase())) return answer;
    }
    if (opts.default !== undefined) return opts.default;
    throw new Error(`FakePrompter: no scripted answer for "${question}"`);
  }

  /** No real resource to release — recorded so a test can assert it was closed. */
  closeCalls = 0;
  close(): void {
    this.closeCalls += 1;
  }
}
