// Inline keyboard-shortcut hint rendered next to primary buttons.
//
// Editorial direction: every action has a shortcut, and the shortcut
// reads in vermilion (light) / saffron (dark) right next to its
// trigger so the user doesn't have to invoke the cheatsheet to learn
// the map. D1.4 wires the matching keypress; this stub just renders
// the kbd element with the accent.

interface KeyHintProps {
  shortcut: string;
}

export function KeyHint({ shortcut }: KeyHintProps) {
  return (
    <kbd className="ml-1 inline-flex min-w-[1.25rem] items-center justify-center border border-ink-accent/40 px-1 py-0 font-mono text-[10px] uppercase leading-none text-ink-accent">
      {shortcut}
    </kbd>
  );
}
