// D1.4 — command palette: cmd-k opens a search input + a flat list of
// nav targets and on-the-fly results for memories by title.
//
// Real fuzzy search would be nice, but cheap substring matching covers
// the editorial-grade use case (single human operator, ~thousands of
// rows). The palette uses Radix Dialog for the open/close + focus trap
// so the keyboard behaviour (arrow keys, enter, escape) is in our hands
// but a11y is Radix's problem.

"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

interface CommandItem {
  id: string;
  label: string;
  detail?: string;
  hint?: string;
  href?: string;
  onSelect?: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Open-ended list of items so the host can mix nav targets with
  // search results from any data source.
  items: CommandItem[];
  // Search text is controlled by the host so the data-source queries
  // (memories.list, …) can react to it without the palette
  // re-implementing debouncing.
  query: string;
  onQueryChange: (q: string) => void;
  placeholder?: string;
}

export function CommandPalette({
  open,
  onOpenChange,
  items,
  query,
  onQueryChange,
  placeholder = "Search memories, actions…",
}: CommandPaletteProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Reset selection whenever the candidate list reshapes; keeps the
  // highlight on the first result rather than scrolling off-screen as
  // the user types.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, items.length]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const needle = query.toLowerCase();
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(needle) || (i.detail ?? "").toLowerCase().includes(needle),
    );
  }, [items, query]);

  const select = (item: CommandItem) => {
    onOpenChange(false);
    onQueryChange("");
    if (item.onSelect) item.onSelect();
    else if (item.href) router.push(item.href);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[activeIndex];
      if (target) select(target);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/20" />
        <Dialog.Content
          className="fixed left-1/2 top-[20%] z-50 w-[min(640px,90vw)] -translate-x-1/2 border border-foreground/15 bg-background p-4 font-sans shadow-lg"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search memories and dashboard actions. Use the arrow keys to navigate, enter to select,
            escape to close.
          </Dialog.Description>
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder={placeholder}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKey}
            aria-label="Command palette search"
            className="w-full border-b border-foreground/15 bg-transparent pb-2 text-sm outline-none placeholder:text-foreground/50"
          />
          <ul
            role="listbox"
            aria-label="Command palette results"
            className="mt-3 max-h-[50vh] overflow-y-auto"
          >
            {filtered.length === 0 ? (
              <li className="px-2 py-2 text-sm text-foreground/60">No matches.</li>
            ) : (
              filtered.map((item, i) => (
                <li
                  key={item.id}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`flex items-center justify-between gap-3 rounded-sm px-2 py-2 text-sm ${
                    i === activeIndex ? "bg-ink-accent/10 text-foreground" : "text-foreground/90"
                  }`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => select(item)}
                >
                  <div className="flex flex-col">
                    <span>{item.label}</span>
                    {item.detail ? (
                      <span className="font-mono text-xs text-foreground/60">{item.detail}</span>
                    ) : null}
                  </div>
                  {item.hint ? (
                    <span className="text-xs text-foreground/60">{item.hint}</span>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
