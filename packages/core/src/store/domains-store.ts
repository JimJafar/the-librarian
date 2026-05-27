// Domains store — owner-curated list of valid domain names from
// memory-domain-isolation §4.1.
//
// The `domains` table is SQLite-authoritative (no JSONL ledger backs
// it) and is reserved with `general` on every fresh boot via
// `seedDomains` in projection.ts. This module exposes the CRUD surface
// the dashboard's `/domains` page consumes through tRPC.
//
// Removing a domain that has memories reassigns those memories to
// `general` rather than deleting them — agents shouldn't ever lose
// content because an owner cleaned up their domain list. Removing the
// floor (`general`) is rejected outright since the §4.10 fast path
// depends on at least one domain existing.

import type { DatabaseSync } from "node:sqlite";

export interface DomainsStoreDeps {
  db: DatabaseSync;
}

export interface DomainRecord {
  name: string;
  created_at: string;
  memory_count: number;
}

export interface DomainsStore {
  list(): DomainRecord[];
  add(name: string): DomainRecord;
  remove(name: string): { reassigned: number };
}

const RESERVED_DOMAINS: ReadonlySet<string> = new Set(["general"]);

export function createDomainsStore(deps: DomainsStoreDeps): DomainsStore {
  const { db } = deps;

  function list(): DomainRecord[] {
    return db
      .prepare(
        `SELECT d.name, d.created_at,
                (SELECT COUNT(*) FROM memories m WHERE m.domain = d.name) AS memory_count
           FROM domains d
          ORDER BY d.name`,
      )
      .all() as unknown as DomainRecord[];
  }

  function add(name: string): DomainRecord {
    const cleaned = normalizeName(name);
    if (!cleaned) throw new Error("Domain name must be a non-empty string.");
    if (cleaned.length > 64) throw new Error("Domain name must be 64 characters or fewer.");
    db.prepare("INSERT INTO domains (name, created_at) VALUES (?, ?)").run(
      cleaned,
      new Date().toISOString(),
    );
    return list().find((row) => row.name === cleaned)!;
  }

  function remove(name: string): { reassigned: number } {
    const cleaned = normalizeName(name);
    if (!cleaned) throw new Error("Domain name must be a non-empty string.");
    if (RESERVED_DOMAINS.has(cleaned)) {
      throw new Error(`Cannot remove the floor domain '${cleaned}'.`);
    }
    const existing = db.prepare("SELECT name FROM domains WHERE name = ?").get(cleaned);
    if (!existing) throw new Error(`Domain '${cleaned}' does not exist.`);
    const reassignResult = db
      .prepare("UPDATE memories SET domain = 'general' WHERE domain = ?")
      .run(cleaned);
    db.prepare("DELETE FROM domains WHERE name = ?").run(cleaned);
    return { reassigned: Number(reassignResult.changes ?? 0) };
  }

  return { list, add, remove };
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}
