// The harness-module contract.
//
// Every harness (claude, codex, opencode, hermes, pi) is a module that
// implements this interface. The installer CLI is a thin orchestrator: it
// drives each harness's *native* install path rather than hand-editing
// five config formats. The real per-harness logic lands in a later wave;
// this file is the stable contract the stubs (and that wave) implement
// against.

/** The five supported harness ids. */
export type HarnessId = "claude" | "codex" | "opencode" | "hermes" | "pi";

/** The config a harness needs to wire The Librarian into itself. */
export interface HarnessConfig {
  /** The MCP endpoint URL the harness should talk to. */
  mcpUrl: string;
  /** The bearer token. Goes in a header / env var — never a URL or log. */
  token: string;
  /** The server base URL (origin of the MCP URL by default). */
  serverUrl: string;
}

/** What `detect()` reports about a harness's current state. */
export interface DetectResult {
  /** True iff The Librarian is currently installed into this harness. */
  installed: boolean;
  /** The installed integration version, when detectable. */
  version?: string;
}

/** A single harness integration module. */
export interface HarnessModule {
  /** Stable id used on the CLI and as the dashboard harness key. */
  readonly id: HarnessId;
  /** Human-readable name for tables and prompts. */
  readonly displayName: string;

  /**
   * Live-probe whether The Librarian is installed into this harness and,
   * if so, at what version. A harness whose CLI/binary isn't present
   * should resolve `{ installed: false }` — absence is not an error.
   */
  detect(): Promise<DetectResult>;

  /** Install The Librarian into this harness via its native path. */
  install(cfg: HarnessConfig): Promise<void>;

  /** Remove The Librarian's entry from this harness. */
  uninstall(): Promise<void>;

  /** Update the integration to the current version (idempotent). */
  update(cfg: HarnessConfig): Promise<void>;
}

/**
 * Thrown by a harness operation that hasn't been implemented yet.
 *
 * The stub modules throw this from install/uninstall/update so the
 * orchestration wave has a clear, typed signal — distinct from a real
 * harness failure.
 */
export class NotImplemented extends Error {
  constructor(harness: HarnessId, op: string) {
    super(`${harness}.${op}() is not implemented yet`);
    this.name = "NotImplemented";
  }
}
