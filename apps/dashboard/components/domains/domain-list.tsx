"use client";

import { useState, useTransition } from "react";
import { addDomainAction, removeDomainAction } from "@/app/(memories)/domains/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { Pill } from "@/components/ui-v2/pill";

interface DomainRecord {
  name: string;
  created_at: string;
  memory_count: number;
}

interface Props {
  initial: DomainRecord[];
}

const FLOOR_DOMAIN = "general";

export function DomainList({ initial }: Props) {
  const [domains, setDomains] = useState(initial);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleAdd(form: FormData): void {
    setError(null);
    startTransition(async () => {
      const result = await addDomainAction(form);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Optimistically add; the next revalidate cycle reconciles.
      const next = name.trim();
      setName("");
      setDomains((rows) =>
        rows.some((r) => r.name === next)
          ? rows
          : [...rows, { name: next, created_at: new Date().toISOString(), memory_count: 0 }].sort(
              (a, b) => a.name.localeCompare(b.name),
            ),
      );
    });
  }

  function handleRemove(target: DomainRecord): void {
    setError(null);
    const message =
      target.memory_count > 0
        ? `Remove '${target.name}'? Its ${target.memory_count} memor${
            target.memory_count === 1 ? "y" : "ies"
          } will be reassigned to '${FLOOR_DOMAIN}'.`
        : `Remove '${target.name}'?`;
    if (!confirm(message)) return;
    startTransition(async () => {
      const result = await removeDomainAction(target.name);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDomains((rows) => rows.filter((r) => r.name !== target.name));
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <form action={handleAdd} className="flex items-start gap-2">
        <Input
          name="name"
          placeholder="Domain name (e.g. coding, family-admin)"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={64}
          disabled={pending}
          aria-label="New domain name"
        />
        <Button type="submit" variant="primary" disabled={pending || name.trim().length === 0}>
          Add
        </Button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <ul className="flex flex-col gap-2">
        {domains.length === 0 ? (
          <li className="text-sm text-muted-foreground">No domains yet.</li>
        ) : (
          domains.map((domain) => (
            <li
              key={domain.name}
              className="flex items-center justify-between rounded-md border bg-card p-3"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{domain.name}</span>
                  <Pill>
                    {domain.memory_count} memor{domain.memory_count === 1 ? "y" : "ies"}
                  </Pill>
                  {domain.name === FLOOR_DOMAIN && <Pill>floor</Pill>}
                </div>
                <span className="text-xs text-muted-foreground">
                  created {new Date(domain.created_at).toLocaleString()}
                </span>
              </div>
              <Button
                variant="outline"
                disabled={pending || domain.name === FLOOR_DOMAIN}
                aria-label={`Remove ${domain.name}`}
                onClick={() => handleRemove(domain)}
              >
                Remove
              </Button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
