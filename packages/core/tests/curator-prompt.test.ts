// Curator prompt assembly (spec §10.4).
//
// Composes the messages sent to the LLM: fixed curator SYSTEM instructions
// (output schema + the code-enforced rules + prompt-injection framing) → the
// redacted slice EVIDENCE + pre-pass findings → the admin prompt ADDENDUM, which
// is redacted and positioned as advisory-only operator guidance that can never
// override the rules or schema (§7.1). Pure string assembly; no LLM call.

import { type MemoryEvidenceBundle, type PrepassResult, buildCuratorPrompt } from "@librarian/core";
import { describe, expect, it } from "vitest";

function memBundle(parts: Partial<MemoryEvidenceBundle> = {}): MemoryEvidenceBundle {
  return {
    slice: { kind: "common_project", projectKey: "proj-x" },
    activeMemories: [],
    proposedMemories: [],
    tombstones: [],
    truncatedMemories: false,
    truncatedFields: false,
    redactionCount: 0,
    ...parts,
  };
}

const noPrepass: PrepassResult = { findings: [] };

function activeMem(
  id: string,
  title: string,
  body: string,
): MemoryEvidenceBundle["activeMemories"][number] {
  return {
    id,
    title,
    body,
    projectKey: "proj-x",
    agentId: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    requiresApproval: false,
    isGlobal: false,
  };
}

describe("buildCuratorPrompt", () => {
  it("returns a system message first, then a user message", () => {
    const messages = buildCuratorPrompt({ memory: memBundle(), prepass: noPrepass });
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
  });

  it("the system message states the JSON output contract and the operation types", () => {
    const [system] = buildCuratorPrompt({ memory: memBundle(), prepass: noPrepass });
    const c = system!.content;
    expect(c).toMatch(/json/i);
    expect(c).toContain("operations");
    expect(c).toContain("confidence");
    for (const op of ["noop", "archive", "update", "merge", "split", "create"]) {
      expect(c).toContain(op);
    }
  });

  it("the system message enforces the key code-side rules and prompt-injection framing", () => {
    const [system] = buildCuratorPrompt({ memory: memBundle(), prepass: noPrepass });
    const c = system!.content.toLowerCase();
    expect(c).toMatch(/untrusted|not (commands|instructions)/); // injection hardening
    expect(c).toMatch(/visibility|boundary/); // slice-boundary rule
    expect(c).toMatch(/secret|credential/); // secret rule
    expect(c).toMatch(/identity|protected/); // protected categories
  });

  it("the system message has no session framing after the rethink", () => {
    const [system] = buildCuratorPrompt({ memory: memBundle(), prepass: noPrepass });
    expect(system!.content).not.toMatch(/session/i);
    expect(system!.content).not.toContain("source_session_ids");
  });

  it("the user message carries the evidence ids and pre-pass findings", () => {
    const messages = buildCuratorPrompt({
      memory: memBundle({
        activeMemories: [activeMem("mem_a", "Title A", "Body A")],
        tombstones: [
          {
            id: "mem_dead",
            title: "Old",
            projectKey: "proj-x",
            agentId: null,
            archivedAt: "2026-01-01T00:00:00.000Z",
            archiveReason: null,
            contentFingerprint: "f".repeat(64),
            normalizedTitle: "old",
          },
        ],
      }),
      prepass: { findings: [{ kind: "exact_duplicate", memoryIds: ["mem_a"], rationale: "dup" }] },
    });
    const user = messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("mem_a");
    expect(user).toContain("Body A");
    expect(user).toContain("mem_dead"); // tombstone surfaced (resurrection avoidance)
    expect(user).toContain("exact_duplicate");
  });

  it("notes truncation so the model knows evidence was trimmed", () => {
    const messages = buildCuratorPrompt({
      memory: memBundle({ truncatedMemories: true }),
      prepass: noPrepass,
    });
    const user = messages.find((m) => m.role === "user")!.content;
    expect(user).toMatch(/truncat/i);
  });

  it("includes the admin addendum as advisory-only, redacted operator guidance", () => {
    const messages = buildCuratorPrompt({
      memory: memBundle(),
      prepass: noPrepass,
      promptAddendum: 'prefer merging; token = "FAKEADDENDUMSECRET"',
    });
    const all = messages.map((m) => m.content).join("\n");
    expect(all).toContain("prefer merging");
    expect(all).toMatch(/advisory|operator guidance/i);
    // The addendum is redacted before it reaches the provider.
    expect(all).not.toContain("FAKEADDENDUMSECRET");
    expect(all).toContain("[REDACTED:secret]");
  });

  it("omits the addendum section when none is configured", () => {
    const messages = buildCuratorPrompt({ memory: memBundle(), prepass: noPrepass });
    const all = messages
      .map((m) => m.content)
      .join("\n")
      .toLowerCase();
    expect(all).not.toContain("operator guidance");
  });
});
