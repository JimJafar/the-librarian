// Add a reference from the dashboard (spec 073 T5).
//
// The affordance the product's own pitch — "upload a spec once and every agent
// can search it" — promised and never had. Until now the only ways in were the
// browser/phone clippers and an admin typing into the Vault page's textarea.
//
// Three inputs, one submit: a URL to fetch, a .md file to pick, or text to
// paste. The file is read in the BROWSER (File API) and sent as text, so there
// is no upload endpoint and no multipart parsing — picking a file and pasting
// its contents take exactly the same server path.

"use client";

import { useState, useTransition } from "react";
import { addReferenceAction } from "@/app/(memories)/actions";
import { Button } from "@/components/ui-v2/button";
import { SectionLabel } from "@/components/ui-v2/section-label";

type Mode = "url" | "paste";

export function AddReferenceDialog({ onFiled }: { onFiled?: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /** Clear the inputs — deliberately NOT `filed`, which is the receipt. */
  const clearInputs = () => {
    setUrl("");
    setContent("");
    setTitle("");
    setError(null);
  };

  // The file never leaves the browser as a file — we read its text and submit
  // that, so this path and paste converge before they reach the server.
  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setMode("paste");
    setContent(await file.text());
    if (!title.trim()) setTitle(file.name.replace(/\.(md|markdown)$/i, ""));
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await addReferenceAction(
        mode === "url"
          ? { url: url.trim() }
          : { content, ...(title.trim() ? { title: title.trim() } : {}) },
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Clear the inputs but keep the panel open and the receipt visible, so
      // filing a second reference doesn't mean reopening the panel.
      clearInputs();
      setFiled(result.path);
      onFiled?.(result.path);
    });
  };

  const canSubmit =
    !pending && (mode === "url" ? url.trim().length > 0 : content.trim().length > 0);

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <Button onClick={() => setOpen(true)}>Add reference</Button>
        {filed ? (
          <p role="status" className="text-xs text-foreground/60">
            Filed <span className="font-mono">{filed}</span>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <section
      aria-label="Add reference"
      className="flex flex-col gap-3 border border-ink-hairline bg-foreground/[0.02] p-3"
    >
      <SectionLabel>Add reference</SectionLabel>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Reference source">
        <Button
          variant={mode === "url" ? "primary" : "outline"}
          aria-pressed={mode === "url"}
          onClick={() => setMode("url")}
        >
          From a URL
        </Button>
        <Button
          variant={mode === "paste" ? "primary" : "outline"}
          aria-pressed={mode === "paste"}
          onClick={() => setMode("paste")}
        >
          Paste or upload Markdown
        </Button>
      </div>

      {mode === "url" ? (
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-foreground/55">
            Page URL
          </span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/a-spec"
            className="border border-ink-hairline bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
          />
          <span className="text-xs text-foreground/50">
            Fetched and converted to Markdown here, the same way the browser clipper does.
          </span>
        </label>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-wider text-foreground/55">
              Title
            </span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Used only when the text has no title of its own"
              className="border border-ink-hairline bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-wider text-foreground/55">
              Markdown
            </span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              placeholder="Paste the document, or choose a .md file below."
              className="border border-ink-hairline bg-transparent px-3 py-2 font-mono text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
            />
          </label>
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept=".md,.markdown,text/markdown"
              aria-label="Choose a Markdown file"
              onChange={(e) => void onPickFile(e.target.files?.[0])}
              className="text-xs text-foreground/70 file:mr-2 file:border file:border-ink-hairline file:bg-transparent file:px-2 file:py-1 file:text-xs file:text-foreground"
            />
          </div>
          <p className="text-xs text-foreground/50">
            Any frontmatter the file already has is kept — only what is missing gets added.
          </p>
        </>
      )}

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.04] p-2 text-sm leading-relaxed text-destructive"
        >
          {error}
        </p>
      ) : null}

      {filed ? (
        <p role="status" className="text-xs text-foreground/60">
          Filed <span className="font-mono">{filed}</span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-hairline pt-3">
        <Button
          onClick={() => {
            clearInputs();
            setFiled(null);
            setOpen(false);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={!canSubmit}>
          {pending ? "Filing…" : "File reference"}
        </Button>
      </div>
    </section>
  );
}
