// distillIntakeExamples (proposal-review rework 2026-07-01, F4 / D3).
//
// The "Reject & make an example" flow's curator call: given the CURRENT
// examples document + one rejected submission (+ an optional owner note), the
// model returns the updated WHOLE document within the byte cap — merging and
// generalizing, never a blind append. Pure proposal generator: it writes
// nothing; the dialog's explicit confirm commits via setIntakeExamples. Pins:
//   - the prompt carries the current doc, the submission, the note, the cap;
//   - untrusted text (submission/note) is redacted before the provider;
//   - a fenced/padded completion parses to the bare document;
//   - an over-cap draft gets ONE condense retry; a second over-cap draft is a
//     teaching error naming the cap; an empty draft is an error.

import { type LlmClient, distillIntakeExamples } from "@librarian/core";
import { describe, expect, it } from "vitest";

function scriptedClient(completions: string[]): {
  client: LlmClient;
  prompts: string[];
  jsonFlags: (boolean | undefined)[];
} {
  const prompts: string[] = [];
  const jsonFlags: (boolean | undefined)[] = [];
  let i = 0;
  const client: LlmClient = {
    complete: async (request) => {
      prompts.push(request.messages.map((m) => `${m.role}: ${m.content}`).join("\n---\n"));
      jsonFlags.push(request.jsonResponse);
      return {
        content: completions[Math.min(i++, completions.length - 1)]!,
        model: "m",
        usage: null,
      };
    },
  };
  return { client, prompts, jsonFlags };
}

const submission = {
  title: "TODO fix flaky test",
  body: "TODO: fix the flaky auth test tomorrow.",
};

describe("distillIntakeExamples", () => {
  it("prompts with the current doc, the rejected submission, the note, and the cap; returns the draft", async () => {
    const { client, prompts } = scriptedClient(["- One-off TODO items: not memory-worthy."]);
    const result = await distillIntakeExamples({
      client,
      currentDoc: "- Existing example entry.",
      submission,
      adminNote: "one-off task noise",
      maxBytes: 4096,
    });
    expect(result.content).toBe("- One-off TODO items: not memory-worthy.");
    const prompt = prompts[0]!;
    expect(prompt).toContain("- Existing example entry.");
    expect(prompt).toContain("TODO: fix the flaky auth test tomorrow.");
    expect(prompt).toContain("one-off task noise");
    expect(prompt).toContain("4096");
  });

  it("redacts secret-shaped submission text before it reaches the provider", async () => {
    // Runtime-assembled secret shape (GitGuardian scans source).
    const secretish = `${"api_key"} = "fake-distill-secret"`;
    const { client, prompts } = scriptedClient(["- entry."]);
    await distillIntakeExamples({
      client,
      currentDoc: "",
      submission: { title: "creds", body: secretish },
      adminNote: secretish,
      maxBytes: 4096,
    });
    expect(prompts[0]!).not.toContain("fake-distill-secret");
  });

  it("requests PLAIN TEXT, never JSON mode — on the first draft AND the condense retry", async () => {
    // Regression: the shared LLM client defaults jsonResponse to true, which
    // sends OpenAI's response_format json_object. Distill wants markdown, and
    // json mode with a no-JSON prompt is an HTTP 400 on OpenAI-compatible
    // providers — the client must opt out explicitly on every distill call.
    const { client, jsonFlags } = scriptedClient(["x".repeat(200), "- condensed."]);
    await distillIntakeExamples({ client, currentDoc: "", submission, maxBytes: 100 });
    expect(jsonFlags).toEqual([false, false]);
  });

  it("strips a markdown code fence from the completion", async () => {
    const { client } = scriptedClient(["```markdown\n- fenced entry.\n```"]);
    const result = await distillIntakeExamples({
      client,
      currentDoc: "",
      submission,
      maxBytes: 4096,
    });
    expect(result.content).toBe("- fenced entry.");
  });

  it("retries ONCE with a condense instruction when the draft exceeds the cap", async () => {
    const { client, prompts } = scriptedClient(["x".repeat(200), "- condensed."]);
    const result = await distillIntakeExamples({
      client,
      currentDoc: "",
      submission,
      maxBytes: 100,
    });
    expect(result.content).toBe("- condensed.");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!).toMatch(/condense|shorter|100/i);
  });

  it("throws a teaching error naming the cap when the retry is still over", async () => {
    const { client } = scriptedClient(["x".repeat(200), "y".repeat(150)]);
    await expect(
      distillIntakeExamples({ client, currentDoc: "", submission, maxBytes: 100 }),
    ).rejects.toThrow(/100/);
  });

  it("throws on an empty completion", async () => {
    const { client } = scriptedClient(["   "]);
    await expect(
      distillIntakeExamples({ client, currentDoc: "", submission, maxBytes: 4096 }),
    ).rejects.toThrow(/empty/i);
  });
});
