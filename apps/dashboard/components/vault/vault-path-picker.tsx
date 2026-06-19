"use client";

// A folder combobox over the vault's existing directories (spec 2026-06-19):
// type to filter the list, click or keyboard-pick a folder, or type a
// brand-new one (it suggests, never restricts). Shared by the New-file dialog
// and the Move dialog so "pick where this lands" is one consistent control.
//
// Controlled + presentational: `directories` + `value` in, `onChange` out — the
// host owns the data (derived from vault.tree) and the value. Selection fires on
// mouseDown, not click, so it lands before the input's blur closes the list
// (the classic combobox ordering trap). Order is preserved from `directories`;
// the host sorts if it wants a sorted menu.

import { useEffect, useId, useMemo, useRef, useState } from "react";

export function VaultPathPicker({
  label,
  directories,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  directories: string[];
  value: string;
  onChange: (folder: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return directories;
    return directories.filter((dir) => dir.toLowerCase().includes(q));
  }, [directories, value]);

  // Reshaping the list resets the highlight to the top, so Enter never fires a
  // stale row that scrolled out from under it.
  useEffect(() => {
    setActiveIndex(0);
  }, [value]);

  const select = (dir: string) => {
    onChange(dir);
    setOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const target = filtered[activeIndex];
      if (open && target !== undefined) {
        e.preventDefault();
        select(target);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="w-full border border-ink-hairline bg-ink-surface px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent pointer-coarse:min-h-11 pointer-coarse:py-2.5 pointer-coarse:text-sm"
      />
      {open && filtered.length > 0 ? (
        <ul
          role="listbox"
          id={listId}
          aria-label={label}
          className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto border border-ink-hairline bg-background shadow-lg"
        >
          {filtered.map((dir, i) => (
            <li
              key={dir === "" ? "(root)" : dir}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              // mouseDown, not click: fire selection before the input blurs.
              onMouseDown={(e) => {
                e.preventDefault();
                select(dir);
              }}
              className={`cursor-pointer px-2 py-1.5 font-mono text-xs pointer-coarse:min-h-11 pointer-coarse:py-2.5 pointer-coarse:text-sm ${
                i === activeIndex ? "bg-ink-accent/10 text-foreground" : "text-foreground/90"
              }`}
            >
              {dir === "" ? "(vault root)" : dir}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
