"use client";

// New-file dialog (spec 2026-06-19): choose where the file lands with the
// VaultPathPicker folder combobox + a filename field, instead of hand-typing
// the whole vault-relative path. Extracted from vault-explorer so it's testable
// in isolation and can share the picker with the Move dialog.

import { useRouter } from "next/navigation";
import { type FormEvent, type Ref, useState, useTransition } from "react";
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
import type { VaultActions } from "@/components/vault/file-view";
import { VaultPathPicker } from "@/components/vault/vault-path-picker";

/** Join folder + filename into a vault-relative path (root folder → bare name). */
export function composePath(folder: string, filename: string): string {
  const dir = folder.trim().replace(/\/+$/, "");
  const name = filename.trim();
  return dir ? `${dir}/${name}` : name;
}

export function NewFileDialog({
  onCreate,
  directories,
  triggerRef,
}: {
  onCreate: VaultActions["create"];
  directories: string[];
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState("");
  const [filename, setFilename] = useState("");
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const path = composePath(folder, filename);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onCreate({ path, raw });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setError(null);
      router.push(`/?path=${encodeURIComponent(path)}`);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button ref={triggerRef} variant="outline" onClick={() => setOpen(true)}>
        New file
        <KeyHint shortcut="N" />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New vault file</DialogTitle>
          <DialogDescription>
            Pick a folder (or type a new one) and name the file. Memories and handoffs are validated
            against their schemas on save.
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
              placeholder="style-guide.md"
              aria-label="File name"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Content
            <textarea
              aria-label="New file content"
              className="min-h-[120px] border border-ink-hairline bg-ink-mono-fill p-2 font-mono text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !filename.trim()}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
