"use client";

// The vault file view (rethink T18/T19): rendered markdown with clickable
// wikilinks, the frontmatter property table, the backlinks pane, and the
// write-side chrome — edit toggle, rename + delete behind confirm dialogs.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type {
  RenameVaultFileResult,
  SaveVaultFileResult,
  VaultActionResult,
} from "@/app/vault/actions";
import { Button } from "@/components/ui-v2/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui-v2/dialog";
import { Input } from "@/components/ui-v2/input";
import { VaultEditor } from "@/components/vault/editor";
import { MarkdownContent } from "@/components/vault/markdown-content";
import type { VaultFile } from "@/components/vault/types";

export interface VaultActions {
  save: (input: {
    path: string;
    raw: string;
    expectedHash: string;
  }) => Promise<SaveVaultFileResult>;
  create: (input: { path: string; raw: string }) => Promise<VaultActionResult>;
  rename: (input: { from: string; to: string }) => Promise<RenameVaultFileResult>;
  remove: (input: { path: string }) => Promise<VaultActionResult>;
}

export function FileView({ file, actions }: { file: VaultFile; actions: VaultActions }) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-sm text-foreground">{file.path}</h2>
        <span className="rounded-sm border border-ink-hairline px-1.5 py-0.5 text-xs uppercase text-muted-foreground">
          {file.kind}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {editing ? null : (
            <Button variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          <RenameDialog path={file.path} onRename={actions.rename} />
          <DeleteDialog path={file.path} onDelete={actions.remove} />
        </span>
      </header>

      {editing ? (
        <VaultEditor file={file} onSave={actions.save} onDone={() => setEditing(false)} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <article className="rounded-md border bg-card p-6">
            <MarkdownContent body={file.body} links={file.links} />
          </article>
          <aside className="flex flex-col gap-4">
            {file.frontmatter ? <FrontmatterTable frontmatter={file.frontmatter} /> : null}
            <BacklinksPane backlinks={file.backlinks} />
            <p className="text-xs text-muted-foreground">Last modified {file.mtime}</p>
          </aside>
        </div>
      )}
    </div>
  );
}

/** Frontmatter as a property table — whatever keys the file carries. */
function FrontmatterTable({ frontmatter }: { frontmatter: Record<string, unknown> }) {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return null;
  return (
    <section aria-label="Frontmatter" className="rounded-md border bg-card p-4 text-sm">
      <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">Properties</h3>
      <dl className="flex flex-col gap-2">
        {entries.map(([key, value]) => (
          <div key={key} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{key}</dt>
            <dd className="break-all font-mono text-xs text-foreground">
              {formatFrontmatterValue(value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function formatFrontmatterValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.length > 0 ? value.join(", ") : "—";
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The "what links here" pane, from the server-built link index. */
function BacklinksPane({ backlinks }: { backlinks: string[] }) {
  return (
    <section aria-label="Backlinks" className="rounded-md border bg-card p-4 text-sm">
      <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">Backlinks</h3>
      {backlinks.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing links here.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {backlinks.map((path) => (
            <li key={path}>
              <Link
                href={`/vault?path=${encodeURIComponent(path)}`}
                className="font-mono text-xs underline"
              >
                {path}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RenameDialog({ path, onRename }: { path: string; onRename: VaultActions["rename"] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(path);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onRename({ from: path, to: to.trim() });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setError(null);
      router.push(`/vault?path=${encodeURIComponent(result.path)}`);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setTo(path);
      }}
    >
      <Button variant="outline" onClick={() => setOpen(true)}>
        Rename
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename file</DialogTitle>
          <DialogDescription>
            Wikilinks pointing at the old filename are rewritten across the vault, so nothing
            dangles.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            New path
            <Input
              variant="mono"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label="New file path"
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={pending || !to.trim() || to.trim() === path}
            >
              {pending ? "Renaming…" : "Rename file"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ path, onDelete }: { path: string; onDelete: VaultActions["remove"] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const confirm = () => {
    startTransition(async () => {
      const result = await onDelete({ path });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setError(null);
      router.push("/vault");
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {path}?</DialogTitle>
          <DialogDescription>
            The file is removed from the vault as a git commit — it stays recoverable from the
            vault’s history.
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={confirm} disabled={pending}>
            {pending ? "Deleting…" : "Delete file"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
