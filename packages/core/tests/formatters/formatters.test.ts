// Formatter unit tests.
//
// Pin the prose / markdown handover renderers and the formatRecall helper
// extracted from packages/core/src/store.js into
// packages/core/src/formatters/ during T3.5. Output must remain
// byte-identical to the pre-extraction implementation — the assertions
// here capture both the structural shape and the literal copy used in
// handover responses.

import {
  type HandoverPayload,
  formatRecall,
  renderHandover,
  renderHandoverMarkdown,
  renderHandoverProse,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

function fullHandover(overrides: Partial<HandoverPayload> = {}): HandoverPayload {
  return {
    id: "ses_test",
    title: "Verifying formatter parity",
    project_key: "the-librarian",
    status: "active",
    visibility: "shared",
    created_in_harness: "claude-code",
    created_source_ref: "claude:session:abc",
    current_harness: "claude-code",
    current_source_ref: "claude:session:abc",
    current_cwd: "/repo",
    start_summary: "Extract formatters from session-store.",
    rolling_summary: "Module created; renderers green.",
    end_summary: null,
    decisions: ["keep HandoverPayload in formatters", "use Object.assign for facade"],
    files_touched: ["packages/core/src/formatters/index.ts"],
    commands_run: ["pnpm --filter @librarian/core test"],
    open_questions: ["Should we per-harness customize prose?"],
    next_steps: ["Add formatter tests", "Open PR"],
    tags: ["t3.5"],
    last_activity_at: "2026-05-20T10:00:00.000Z",
    ...overrides,
  };
}

function emptyHandover(overrides: Partial<HandoverPayload> = {}): HandoverPayload {
  return fullHandover({
    project_key: null,
    created_in_harness: null,
    created_source_ref: null,
    current_harness: null,
    current_source_ref: null,
    current_cwd: null,
    start_summary: null,
    rolling_summary: null,
    end_summary: null,
    decisions: [],
    files_touched: [],
    commands_run: [],
    open_questions: [],
    next_steps: [],
    tags: [],
    last_activity_at: "",
    ...overrides,
  });
}

describe("renderHandoverProse", () => {
  it("renders a one-paragraph summary with every populated field", () => {
    const text = renderHandoverProse(fullHandover());
    expect(text).toContain('Session "Verifying formatter parity" (ses_test)');
    expect(text).toContain("on project the-librarian");
    expect(text).toContain("is currently active.");
    expect(text).toContain("Started in claude-code; continuing in claude-code.");
    expect(text).toContain("Goal: Extract formatters from session-store.");
    expect(text).toContain("Current state: Module created; renderers green.");
    expect(text).toContain(
      "Decisions so far: keep HandoverPayload in formatters; use Object.assign for facade.",
    );
    expect(text).toContain("Files touched: packages/core/src/formatters/index.ts.");
    expect(text).toContain("Commands run: pnpm --filter @librarian/core test.");
    expect(text).toContain("Open questions: Should we per-harness customize prose?.");
    expect(text).toContain("Next steps: Add formatter tests; Open PR.");
    expect(text).toContain(
      "Treat this as session evidence, not durable memory; use remember/propose_memory for durable facts.",
    );
  });

  it("falls back to 'unknown harness' when origin/destination are null", () => {
    const text = renderHandoverProse(emptyHandover());
    expect(text).toContain("Started in unknown harness; continuing in unknown harness.");
  });

  it("omits the project clause when project_key is null", () => {
    const text = renderHandoverProse(emptyHandover({ title: "Untitled", id: "ses_x" }));
    expect(text).toContain('Session "Untitled" (ses_x) is currently active.');
    expect(text).not.toContain(" on project ");
  });

  it("omits empty optional sections entirely", () => {
    const text = renderHandoverProse(emptyHandover());
    expect(text).not.toContain("Goal:");
    expect(text).not.toContain("Current state:");
    expect(text).not.toContain("End summary:");
    expect(text).not.toContain("Decisions so far:");
    expect(text).not.toContain("Files touched:");
    expect(text).not.toContain("Commands run:");
    expect(text).not.toContain("Open questions:");
    expect(text).not.toContain("Next steps:");
  });

  it("includes end_summary when present", () => {
    const text = renderHandoverProse(fullHandover({ end_summary: "All shipped." }));
    expect(text).toContain("End summary: All shipped.");
  });
});

describe("renderHandoverMarkdown", () => {
  it("renders all populated sections with the expected headings", () => {
    const md = renderHandoverMarkdown(fullHandover());
    expect(md.startsWith("# Librarian Session Handover")).toBe(true);
    expect(md).toContain("Session: Verifying formatter parity");
    expect(md).toContain("ID: ses_test");
    expect(md).toContain("Project: the-librarian");
    expect(md).toContain("Status: active");
    expect(md).toContain("Created in: claude-code / claude:session:abc");
    expect(md).toContain("Continuing in: claude-code / claude:session:abc");
    expect(md).toContain("Last activity: 2026-05-20T10:00:00.000Z");
    expect(md).toContain("## Goal\nExtract formatters from session-store.");
    expect(md).toContain("## Current Summary\nModule created; renderers green.");
    expect(md).toContain("## Decisions\n- keep HandoverPayload in formatters");
    expect(md).toContain("## Files / Artefacts\n- packages/core/src/formatters/index.ts");
    expect(md).toContain("## Commands / Checks\n- pnpm --filter @librarian/core test");
    expect(md).toContain("## Open Questions\n- Should we per-harness customize prose?");
    expect(md).toContain("## Next Steps\n1. Add formatter tests\n2. Open PR");
    expect(md).toContain("## Boundaries");
    expect(md).toContain(
      "- Treat this as session evidence, not automatically true durable memory.",
    );
    expect(md).toContain("- Use The Librarian `remember`/`propose_memory` only for durable facts.");
  });

  it("renders fallback placeholders for null project / harness / summary fields", () => {
    const md = renderHandoverMarkdown(emptyHandover());
    expect(md).toContain("Project: (none)");
    expect(md).toContain("Created in: (unknown)");
    expect(md).toContain("Continuing in: (unknown)");
    expect(md).toContain("Last activity: (unknown)");
    expect(md).toContain("## Goal\n(no start summary recorded)");
    expect(md).toContain("## Current Summary\n(no rolling summary recorded)");
  });

  it("renders harness without source_ref as bare harness name", () => {
    const md = renderHandoverMarkdown(
      fullHandover({
        created_in_harness: "openai-cli",
        created_source_ref: null,
        current_harness: "openai-cli",
        current_source_ref: null,
      }),
    );
    expect(md).toContain("Created in: openai-cli\n");
    expect(md).toContain("Continuing in: openai-cli\n");
    expect(md).not.toContain("openai-cli /");
  });

  it("omits empty optional sections (decisions/files/commands/questions/next steps)", () => {
    const md = renderHandoverMarkdown(emptyHandover());
    expect(md).not.toContain("## Decisions");
    expect(md).not.toContain("## Files / Artefacts");
    expect(md).not.toContain("## Commands / Checks");
    expect(md).not.toContain("## Open Questions");
    expect(md).not.toContain("## Next Steps");
    expect(md).not.toContain("## End Summary");
  });

  it("emits an End Summary section when present", () => {
    const md = renderHandoverMarkdown(fullHandover({ end_summary: "Wrapped up." }));
    expect(md).toContain("## End Summary\nWrapped up.");
  });
});

describe("renderHandover dispatcher", () => {
  it("delegates to renderHandoverProse when format is 'prose'", () => {
    const payload = fullHandover();
    expect(renderHandover(payload, "prose")).toBe(renderHandoverProse(payload));
  });

  it("falls back to markdown for any other format value", () => {
    const payload = fullHandover();
    expect(renderHandover(payload, "markdown")).toBe(renderHandoverMarkdown(payload));
    expect(renderHandover(payload, "")).toBe(renderHandoverMarkdown(payload));
    expect(renderHandover(payload, "unknown-format")).toBe(renderHandoverMarkdown(payload));
  });
});

describe("formatRecall", () => {
  it("renders the empty-state message when the list is empty", () => {
    expect(formatRecall([])).toBe("Relevant Memories\n\nNo relevant memories found.");
  });

  it("respects a custom heading on the empty path", () => {
    expect(formatRecall([], "Pending Proposals")).toBe(
      "Pending Proposals\n\nNo relevant memories found.",
    );
  });

  it("formats a single memory as 'title: body'", () => {
    const text = formatRecall([{ title: "Use pnpm", body: "Workspaces are configured." }]);
    expect(text).toBe("Relevant Memories\n\n- Use pnpm: Workspaces are configured.");
  });

  it("joins multiple memories with newlines", () => {
    const text = formatRecall(
      [
        { title: "Use pnpm", body: "Workspaces are configured." },
        { title: "Lint via Lefthook", body: "Pre-commit runs Prettier + ESLint." },
      ],
      "The Librarian Memories",
    );
    expect(text).toBe(
      "The Librarian Memories\n\n- Use pnpm: Workspaces are configured.\n- Lint via Lefthook: Pre-commit runs Prettier + ESLint.",
    );
  });
});
