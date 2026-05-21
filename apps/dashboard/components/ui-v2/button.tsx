// Editorial-style button stub for the D1.x dashboard redesign.
//
// Per spec: outline default, optional primary variant for the one
// real action per surface. No drop shadows; hairline border + ink
// foreground. Real interaction logic lives downstream in D1.1–D1.4.

import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "outline" | "primary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  outline: "border border-foreground/20 bg-transparent text-foreground hover:bg-foreground/[0.04]",
  primary: "border border-ink-accent bg-transparent text-ink-accent hover:bg-ink-accent/[0.06]",
  ghost: "border border-transparent text-foreground hover:bg-foreground/[0.04]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "outline", className = "", children, ...rest },
  ref,
) {
  const base =
    "inline-flex items-center gap-2 rounded-none px-3 py-1.5 text-sm font-sans transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <button ref={ref} className={`${base} ${variants[variant]} ${className}`.trim()} {...rest}>
      {children}
    </button>
  );
});
