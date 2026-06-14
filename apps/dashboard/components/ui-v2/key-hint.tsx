// Inline keyboard-shortcut hint rendered next to primary buttons.
//
// Editorial direction: every action has a shortcut, and the shortcut
// reads in vermilion (light) / saffron (dark) right next to its
// trigger so the user doesn't have to invoke the cheatsheet to learn
// the map. The kbd is `aria-hidden` because it's a sighted mnemonic —
// the canonical machine-readable form is `aria-keyshortcuts` on the
// trigger itself, and including this in a button's accessible name
// would read "Delete D" rather than "Delete" to screen readers.

interface KeyHintProps {
  shortcut: string;
}

export function KeyHint({ shortcut }: KeyHintProps) {
  // Coarse pointers (touch) don't have a keyboard to invoke the shortcut,
  // so the visual mnemonic is noise. Hide it there; the action stays
  // tappable, just without the kbd hint cluttering the label.
  return (
    <kbd
      aria-hidden
      className="ml-1 inline-flex min-w-[1.25rem] items-center justify-center border border-ink-accent/40 px-1 py-0 font-mono text-[10px] uppercase leading-none text-ink-accent pointer-coarse:hidden"
    >
      {shortcut}
    </kbd>
  );
}
