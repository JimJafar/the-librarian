// Claude `PreToolUse` native-memory write-block — pure path-classify unit tests +
// fail-open orchestration tests (spec 2026-06-16-harness-auto-capture, T4 / SC8).
//
// The hook entry (integrations/claude/scripts/block-memory-write.mjs) is a THIN
// shell over the pure classifier in integrations/claude/scripts/lib/
// memory-write-guard.mjs. The classification logic (which paths are the native
// Claude memory store, which are ordinary writes) is asserted here.
//
// Coverage map (spec §2 SC8):
//   - must-BLOCK: a write to the native Claude memory store
//     (`**/.claude/**/memory/**`, its `MEMORY.md`).
//   - must-ALLOW: ordinary source, `docs/**`, `vault/primer.md`, a project's own
//     `src/memory.ts` — NOTHING broader than the native store (ADR 0009: the
//     broad file-write veto was explicitly rejected).
//   - fail-OPEN: any error in the guard (malformed input, no path) → allow.
//   - the block carries a teaching message naming `remember`.
//
// These tests live in the root `test/` dir so the root `vitest run` picks them up
// under `pnpm test` (integrations/claude is not its own workspace package).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(REPO_ROOT, "integrations", "claude", "scripts", "lib");

const guard = await import(path.join(LIB, "memory-write-guard.mjs"));

// ── classifyWritePath: is this the native Claude memory store? ───────────────

describe("classifyWritePath — native memory store detection (SC8)", () => {
  // ── must BLOCK: the native Claude memory store ──
  const mustBlock = [
    // the canonical Claude Code auto-memory store under a user's ~/.claude.
    "/home/u/.claude/projects/-home-u/memory/MEMORY.md",
    // a note file inside the memory store.
    "/home/u/.claude/projects/x/memory/note.md",
    // a project-scoped .claude memory store.
    "/repo/.claude/memory/MEMORY.md",
    // nested under the memory dir.
    "/repo/.claude/agents/memory/topics/auth.md",
    // a relative path that still resolves into a .claude memory store.
    ".claude/projects/p/memory/MEMORY.md",
    // Windows-style separators (defense in depth).
    "C:\\Users\\u\\.claude\\projects\\p\\memory\\MEMORY.md",
  ];
  for (const p of mustBlock) {
    it(`BLOCKS ${p}`, () => {
      expect(guard.isNativeMemoryWrite(p)).toBe(true);
    });
  }

  // ── must ALLOW: everything else (nothing broader — ADR 0009) ──
  const mustAllow = [
    // ordinary source.
    "/repo/src/index.ts",
    // a project's OWN module that merely has "memory" in the name — NOT the store.
    "/repo/src/memory.ts",
    "/repo/packages/core/src/store/memory-context.ts",
    // ordinary docs.
    "/repo/docs/foo.md",
    // the Librarian's own primer — a legit vault write, never blocked.
    "/repo/vault/primer.md",
    // a MEMORY.md that is NOT inside a .claude store (e.g. a user's own notes).
    "/repo/MEMORY.md",
    "/repo/notes/memory/scratch.md",
    // a `.claude` settings file that is NOT in the memory store.
    "/home/u/.claude/settings.json",
    "/repo/.claude/commands/handoff.md",
    // a directory literally named "memory" but not under .claude.
    "/repo/memory/data.json",
  ];
  for (const p of mustAllow) {
    it(`ALLOWS ${p}`, () => {
      expect(guard.isNativeMemoryWrite(p)).toBe(false);
    });
  }
});

// ── extractWritePath: pull the target path off a hook payload ────────────────

describe("extractWritePath — read the target off the hook tool_input", () => {
  it("reads tool_input.file_path (Write / Edit / MultiEdit)", () => {
    expect(guard.extractWritePath({ tool_input: { file_path: "/repo/.claude/memory/x.md" } })).toBe(
      "/repo/.claude/memory/x.md",
    );
  });

  it("falls back to tool_input.path when file_path is absent", () => {
    expect(guard.extractWritePath({ tool_input: { path: "/repo/src/a.ts" } })).toBe(
      "/repo/src/a.ts",
    );
  });

  it("returns null when there is no recognizable path (fail-open upstream)", () => {
    expect(guard.extractWritePath({})).toBeNull();
    expect(guard.extractWritePath({ tool_input: {} })).toBeNull();
    expect(guard.extractWritePath(null)).toBeNull();
    expect(guard.extractWritePath({ tool_input: { file_path: 42 } })).toBeNull();
  });
});

// ── evaluate: the full guard decision + fail-open ────────────────────────────

describe("evaluateMemoryWrite — block decision + teaching message + fail-open", () => {
  it("BLOCKS a native-memory write with a teaching message naming `remember`", () => {
    const result = guard.evaluateMemoryWrite({
      tool_name: "Write",
      tool_input: { file_path: "/home/u/.claude/projects/x/memory/MEMORY.md" },
    });
    expect(result.block).toBe(true);
    expect(result.message).toMatch(/remember/);
    // The message teaches WHERE the memory should go instead (the Librarian).
    expect(result.message).toMatch(/Librarian/i);
  });

  it("ALLOWS an ordinary source write (no block, no message)", () => {
    const result = guard.evaluateMemoryWrite({
      tool_name: "Edit",
      tool_input: { file_path: "/repo/src/index.ts" },
    });
    expect(result.block).toBe(false);
  });

  it("ALLOWS vault/primer.md (a legit Librarian vault write)", () => {
    const result = guard.evaluateMemoryWrite({
      tool_input: { file_path: "/repo/vault/primer.md" },
    });
    expect(result.block).toBe(false);
  });

  it("fails OPEN on malformed input — a guard bug must never block a legit write", () => {
    // No path at all.
    expect(guard.evaluateMemoryWrite({}).block).toBe(false);
    expect(guard.evaluateMemoryWrite(null).block).toBe(false);
    expect(guard.evaluateMemoryWrite(undefined).block).toBe(false);
    // A path of the wrong type.
    expect(guard.evaluateMemoryWrite({ tool_input: { file_path: { nope: true } } }).block).toBe(
      false,
    );
  });
});
