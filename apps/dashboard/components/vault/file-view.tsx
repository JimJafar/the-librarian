"use client";

// The vault file view (rethink T18/T19): rendered markdown with clickable
// wikilinks, the frontmatter property table, the backlinks pane, and the
// write-side chrome — edit toggle, rename + delete behind confirm dialogs.
// Plus the History tab (rethink T20): per-file commit list, diff view, and
// restore-as-a-new-commit.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
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
import { KeyHint } from "@/components/ui-v2/key-hint";
import { Pill } from "@/components/ui-v2/pill";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui-v2/tabs";
import { VaultEditor } from "@/components/vault/editor";
import { FileHistory, type HistoryActions } from "@/components/vault/file-history";
import { MarkdownContent } from "@/components/vault/markdown-content";
import type { VaultFile } from "@/components/vault/types";

export interface VaultActions extends HistoryActions {
  save: (input: {
    path: string;
    raw: string;
    expectedHash: string;
  }) => Promise<SaveVaultFileResult>;
  create: (input: { path: string; raw: string }) => Promise<VaultActionResult>;
  rename: (input: { from: string; to: string }) => Promise<RenameVaultFileResult>;
  remove: (input: { path: string }) => Promise<VaultActionResult>;
}

type FileViewMode = "view" | "edit" | "history";

export function FileView({ file, actions }: { file: VaultFile; actions: VaultActions }) {
  const [mode, setMode] = useState<FileViewMode>("view");
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Per-surface shortcuts: E switches to Edit, D opens the delete confirm.
  // Skip when focus is in an input/textarea/contenteditable so typing "e"
  // into a search box doesn't yank the user out of their flow. The Tabs
  // own their own arrow-key cycling natively (Radix), so we don't compete.
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "e") {
        event.preventDefault();
        setMode("edit");
      } else if (key === "d") {
        event.preventDefault();
        deleteTriggerRef.current?.click();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 break-all font-mono text-sm text-foreground">{file.path}</h2>
        <Pill variant="default" className="uppercase">
          {file.kind}
        </Pill>
        <span className="ml-auto flex items-center gap-2">
          <RenameDialog path={file.path} onRename={actions.rename} />
          <DeleteDialog path={file.path} onDelete={actions.remove} triggerRef={deleteTriggerRef} />
        </span>
      </header>

      <Tabs value={mode} onValueChange={(next) => setMode(next as FileViewMode)}>
        <TabsList aria-label="File mode">
          <TabsTrigger value="view">Read</TabsTrigger>
          <TabsTrigger value="edit">
            Edit
            <KeyHint shortcut="E" />
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="view">
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <article className="min-w-0 border border-ink-hairline bg-ink-surface px-7 py-8">
              <MarkdownContent body={file.body} links={file.links} />
            </article>
            <aside className="flex min-w-0 flex-col gap-6">
              {file.frontmatter ? <FrontmatterTable frontmatter={file.frontmatter} /> : null}
              <BacklinksPane backlinks={file.backlinks} />
              <p className="text-xs text-foreground/60">Last modified {file.mtime}</p>
            </aside>
          </div>
        </TabsContent>

        <TabsContent value="edit">
          <VaultEditor file={file} onSave={actions.save} onDone={() => setMode("view")} />
        </TabsContent>

        <TabsContent value="history">
          <FileHistory path={file.path} actions={actions} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Frontmatter as a property table — whatever keys the file carries. */
function FrontmatterTable({ frontmatter }: { frontmatter: Record<string, unknown> }) {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return null;
  return (
    <section aria-label="Frontmatter" className="flex flex-col gap-3 text-sm">
      <h3 className="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-foreground/60">
        Properties
      </h3>
      <dl className="flex flex-col divide-y divide-ink-hairline">
        {entries.map(([key, value]) => (
          <div key={key} className="flex flex-col gap-0.5 py-2 first:pt-0">
            <dt className="text-xs text-foreground/60">{key}</dt>
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
    <section aria-label="Backlinks" className="flex flex-col gap-3 text-sm">
      <h3 className="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-foreground/60">
        Backlinks
      </h3>
      {backlinks.length === 0 ? (
        <p className="text-xs text-foreground/60">Nothing links here.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {backlinks.map((path) => (
            <li key={path}>
              <Link
                href={`/vault?path=${encodeURIComponent(path)}`}
                className="block break-all font-mono text-xs text-ink-accent underline underline-offset-2 hover:decoration-2 pointer-coarse:min-h-11 pointer-coarse:py-2 pointer-coarse:text-sm"
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

function DeleteDialog({
  path,
  onDelete,
  triggerRef,
}: {
  path: string;
  onDelete: VaultActions["remove"];
  triggerRef?: React.Ref<HTMLButtonElement>;
}) {
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
      <Button ref={triggerRef} variant="destructive" onClick={() => setOpen(true)}>
        Delete
        <KeyHint shortcut="D" />
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
          <Button type="button" variant="destructive" onClick={confirm} disabled={pending}>
            {pending ? "Deleting…" : "Delete file"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
