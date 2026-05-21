// U1 — editorial Input.
//
// Hairline bottom border (no box), ink-foreground text, optional mono
// variant for technical strings (ids, timestamps, query chips). Direct
// drop-in for the legacy `@/components/ui/input` Input.

import { forwardRef, type InputHTMLAttributes } from "react";

type Variant = "default" | "mono";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  default: "font-sans",
  mono: "font-mono text-xs",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = "", variant = "default", type = "text", ...rest },
  ref,
) {
  const base =
    "block w-full border-0 border-b border-ink-hairline bg-transparent px-1 py-1.5 text-sm text-foreground placeholder:text-foreground/40 focus:border-ink-accent focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <input
      ref={ref}
      type={type}
      className={`${base} ${variants[variant]} ${className}`.trim()}
      {...rest}
    />
  );
});
