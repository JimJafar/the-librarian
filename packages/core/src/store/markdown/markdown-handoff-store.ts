// Markdown-backed HandoffStore (plan 036 Phase 2 / spec 035 §F9). Each
// handoff is `handoffs/<id>.md` (frontmatter + the 5-heading narrative),
// built behind the `HandoffStore` interface.
//
// Sync (like the markdown MemoryStore) with an injected sync committer.

import { makeId, nowIso } from "../../constants.js";
import type {
  ClaimHandoffInput,
  ClaimHandoffOutput,
  HandoffSummary,
  ListHandoffsInput,
  StoreHandoffInput,
  StoreHandoffOutput,
} from "../../schemas/handoff.js";
import { commitSubject } from "../commit-message.js";
import type { Vault } from "../corpus/vault.js";
import {
  type ClaimedBy,
  type HandoffDetail,
  type HandoffStore,
  type ListHandoffsContext,
  type StoreHandoffContext,
  HandoffAlreadyClaimedError,
  HandoffNotFoundError,
} from "../handoff-store.js";
import { parseHandoffDocument, serializeHandoffDocument } from "./handoff-doc.js";

export interface MarkdownHandoffStoreDeps {
  vault: Vault;
  /**
   * Sync commit-per-op — the ATTRIBUTED, pathspec-limited primitive (spec 064 SC 1):
   * `(paths, message, actorId?)`. Each handoff mutation names its one document and passes
   * the acting principal for the `Librarian-Actor` trailer. Omit to skip committing.
   */
  commit?: (paths: string[], message: string, actorId?: string) => void;
  now?: () => string;
  generateId?: () => string;
}

function handoffPath(id: string): string {
  return `handoffs/${id}.md`;
}
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createMarkdownHandoffStore(deps: MarkdownHandoffStoreDeps): HandoffStore {
  const { vault } = deps;
  const now = deps.now ?? nowIso;
  const generateId = deps.generateId ?? (() => makeId("hdo"));
  const commit = deps.commit ?? (() => {});

  function getById(handoffId: string): HandoffDetail | null {
    const raw = vault.tryReadText(handoffPath(handoffId));
    return raw ? parseHandoffDocument(raw) : null;
  }

  function store(input: StoreHandoffInput, context: StoreHandoffContext): StoreHandoffOutput {
    const id = generateId();
    const createdAt = now();
    const detail: HandoffDetail = {
      handoff_id: id,
      title: input.title,
      document_md: input.document_md,
      project_key: input.project_key ?? null,
      source_ref: input.source_ref ?? null,
      cwd: input.cwd ?? null,
      created_by_agent_id: context.created_by_agent_id,
      created_in_harness: input.harness ?? null,
      tags: input.tags ?? [],
      created_at: createdAt,
      claimed_at: null,
      claimed_by: null,
    };
    vault.writeText(handoffPath(id), serializeHandoffDocument(detail));
    commit([handoffPath(id)], commitSubject.handoffStore(id));
    return { handoff_id: id, created_at: createdAt };
  }

  function queryDetails(input: ListHandoffsInput, context: ListHandoffsContext): HandoffDetail[] {
    let docs = vault
      .listMarkdown("handoffs")
      .map((rel) => parseHandoffDocument(vault.readText(rel)));
    if (!context.includeClaimed) docs = docs.filter((d) => d.claimed_at == null);
    if (input.project_key != null) docs = docs.filter((d) => d.project_key === input.project_key);
    if (input.cwd != null) docs = docs.filter((d) => d.cwd === input.cwd);
    if (input.harness != null) docs = docs.filter((d) => d.created_in_harness === input.harness);
    docs.sort((a, b) => cmpStr(b.created_at, a.created_at));
    return docs.slice(0, input.limit ?? 20);
  }

  function list(input: ListHandoffsInput, context: ListHandoffsContext): HandoffSummary[] {
    return queryDetails(input, context).map(toSummary);
  }

  function listDetails(input: ListHandoffsInput, context: ListHandoffsContext): HandoffDetail[] {
    return queryDetails(input, context);
  }

  function claim(input: ClaimHandoffInput): ClaimHandoffOutput {
    // The store is sync — read → check → write runs without a yield, so the
    // claim is atomic within the single server process (the only writer).
    const existing = getById(input.handoff_id);
    if (!existing) throw new HandoffNotFoundError(input.handoff_id);
    if (existing.claimed_at) {
      throw new HandoffAlreadyClaimedError(
        input.handoff_id,
        existing.claimed_at,
        existing.claimed_by,
      );
    }
    const claimedAt = now();
    const claimedBy: ClaimedBy = {
      agent_id: input.claiming_agent_id ?? null,
      harness: input.claiming_harness ?? null,
      source_ref: input.claiming_source_ref ?? null,
      cwd: input.claiming_cwd ?? null,
    };
    const updated: HandoffDetail = { ...existing, claimed_at: claimedAt, claimed_by: claimedBy };
    vault.writeText(handoffPath(input.handoff_id), serializeHandoffDocument(updated));
    commit([handoffPath(input.handoff_id)], commitSubject.handoffClaim(input.handoff_id));
    return {
      handoff_id: updated.handoff_id,
      title: updated.title,
      document_md: updated.document_md,
      created_by_agent_id: updated.created_by_agent_id,
      created_in_harness: updated.created_in_harness,
      created_at: updated.created_at,
      claimed_at: claimedAt,
    };
  }

  function purge(handoffId: string): boolean {
    if (!vault.exists(handoffPath(handoffId))) return false;
    vault.removeFile(handoffPath(handoffId));
    commit([handoffPath(handoffId)], commitSubject.handoffPurge(handoffId));
    return true;
  }

  return { store, list, listDetails, claim, getById, purge };
}

function toSummary(detail: HandoffDetail): HandoffSummary {
  return {
    handoff_id: detail.handoff_id,
    title: detail.title,
    project_key: detail.project_key,
    source_ref: detail.source_ref,
    cwd: detail.cwd,
    created_in_harness: detail.created_in_harness,
    created_by_agent_id: detail.created_by_agent_id,
    created_at: detail.created_at,
    tags: detail.tags,
  };
}
