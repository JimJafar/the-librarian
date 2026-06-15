// Editorial-style button.
//
// Per spec: outline default, optional primary variant for the one
// real action per surface, destructive for irreversible writes,
// ghost for tertiary affordances. No drop shadows; hairline border
// + ink foreground. The focus-visible ring is the rubric accent so
// keyboard users see the same one-mark-of-colour the rest of the
// system reserves for current state.

import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "outline" | "primary" | "destructive" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  outline: "border border-foreground/20 bg-transparent text-foreground hover:bg-foreground/[0.04]",
  primary: "border border-ink-accent bg-transparent text-ink-accent hover:bg-ink-accent/[0.06]",
  destructive:
    "border border-destructive bg-transparent text-destructive hover:bg-destructive/[0.08]",
  ghost: "border border-transparent text-foreground hover:bg-foreground/[0.04]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "outline", className = "", children, ...rest },
  ref,
) {
  // Density is dense by default (operator at a keyboard) — coarse-pointer
  // devices (touch screens) get a 44×44px tap area without changing the
  // desktop's tight rhythm. Focus gets the rubric ring + a soft bloom —
  // the One-Illuminated-Element rule applied to keyboard users so they
  // see the same lit-up reading touch and pointer users get on hover.
  const base =
    "inline-flex items-center gap-2 rounded-none px-3 py-1.5 text-sm font-sans transition-[box-shadow,background-color,color,border-color] focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:[box-shadow:var(--glow-accent)] disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-4 pointer-coarse:py-2.5";
  return (
    <button ref={ref} className={`${base} ${variants[variant]} ${className}`.trim()} {...rest}>
      {children}
    </button>
  );
});
