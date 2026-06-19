"use client";

// The vault file view (rethink T18/T19): rendered markdown with clickable
// wikilinks, the frontmatter property table, the backlinks pane, and the
// write-side chrome — edit toggle, move (folder picker + rename) + delete
// behind confirm dialogs. Plus the History tab (rethink T20): per-file commit
// list, diff view, and restore-as-a-new-commit.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
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
import { SectionLabel } from "@/components/ui-v2/section-label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui-v2/tabs";
import { VaultEditor } from "@/components/vault/editor";
import { FileHistory, type HistoryActions } from "@/components/vault/file-history";
import { MarkdownContent } from "@/components/vault/markdown-content";
import { composePath } from "@/components/vault/new-file-dialog";
import type { VaultFile } from "@/components/vault/types";
import { VaultPathPicker } from "@/components/vault/vault-path-picker";
import { useSurfaceShortcuts } from "@/hooks/use-surface-shortcuts";

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

export function FileView({
  file,
  actions,
  directories,
}: {
  file: VaultFile;
  actions: VaultActions;
  /** Folder option list for the Move dialog's path picker. */
  directories: string[];
}) {
  const [mode, setMode] = useState<FileViewMode>("view");
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Per-file shortcuts: E switches to Edit, D opens the delete confirm.
  // Move/Delete stay role=button (they open dialogs); the Read/Edit/History
  // tabs own their own arrow-key cycling natively (Radix), so we don't compete.
  useSurfaceShortcuts({
    e: () => setMode("edit"),
    d: () => deleteTriggerRef.current?.click(),
  });

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 break-all font-mono text-sm text-foreground">{file.path}</h2>
        <Pill variant="default" className="uppercase">
          {file.kind}
        </Pill>
        <span className="ml-auto flex items-center gap-2">
          <MoveDialog path={file.path} directories={directories} onMove={actions.rename} />
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
            {/* Hairline frame + 1px brass gilt inner rule (the "manuscript
                margin") — gives the editorial surface real edge ornament
                without breaking the flat-by-default rule. */}
            <article className="relative min-w-0 border border-ink-hairline bg-ink-surface px-7 py-8">
              <span
                aria-hidden
                className="pointer-events-none absolute inset-2 border border-ink-copper-soft"
              />
              <div className="relative">
                <MarkdownContent body={file.body} links={file.links} />
              </div>
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
      <SectionLabel>Properties</SectionLabel>
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
      <SectionLabel>Backlinks</SectionLabel>
      {backlinks.length === 0 ? (
        <p className="text-xs text-foreground/60">Nothing links here.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {backlinks.map((path) => (
            <li key={path}>
              <Link
                href={`/?path=${encodeURIComponent(path)}`}
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

/** Split a vault path into its folder + filename (a root file → empty folder). */
function splitPath(path: string): { folder: string; filename: string } {
  const i = path.lastIndexOf("/");
  return i === -1
    ? { folder: "", filename: path }
    : { folder: path.slice(0, i), filename: path.slice(i + 1) };
}

// Move (and rename) a file: pick a destination folder with the path picker and
// adjust the filename. Both go through vault.rename — the wikilink-rewriting
// git mv — so a folder change moves and a filename change renames, in one
// control (spec 2026-06-19, Task 3 — replaces the old Rename dialog).
function MoveDialog({
  path,
  directories,
  onMove,
}: {
  path: string;
  directories: string[];
  onMove: VaultActions["rename"];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const here = splitPath(path);
  const [folder, setFolder] = useState(here.folder);
  const [filename, setFilename] = useState(here.filename);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const to = composePath(folder, filename);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onMove({ from: path, to });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setError(null);
      router.push(`/?path=${encodeURIComponent(result.path)}`);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reset the picker to the file's current location each time it opens.
        if (next) {
          const current = splitPath(path);
          setFolder(current.folder);
          setFilename(current.filename);
          setError(null);
        }
      }}
    >
      <Button variant="outline" onClick={() => setOpen(true)}>
        Move
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move file</DialogTitle>
          <DialogDescription>
            Pick a destination folder (or type a new one) and adjust the filename if you like.
            Wikilinks pointing at the old path are rewritten across the vault, so nothing dangles.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 text-sm">
            Folder
            <VaultPathPicker
              label="Folder"
              directories={directories}
              value={folder}
              onChange={setFolder}
              placeholder="references/AI (leave blank for the vault root)"
            />
          </div>
          <label className="flex flex-col gap-1 text-sm">
            File name
            <Input
              variant="mono"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              aria-label="File name"
            />
          </label>
          <p className="font-mono text-xs text-foreground/55">
            → <span className="text-foreground/80">{to}</span>
          </p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={pending || !filename.trim() || to === path}
            >
              {pending ? "Moving…" : "Move file"}
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
      router.push("/");
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
