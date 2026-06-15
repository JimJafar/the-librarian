// Editorial native select. Wraps a real <select> so screen readers,
// keyboard, and mobile pickers all behave; renders the chevron + a
// hairline divider as a visible affordance on the right so the
// control reads as a dropdown trigger at a glance (not just a styled
// input). The chevron is `pointer-events-none` so clicks land on the
// underlying <select>.

import { forwardRef, type SelectHTMLAttributes } from "react";

type Variant = "default" | "compact";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  default: "h-9 text-sm pr-10",
  compact: "h-8 text-xs pr-9",
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { variant = "default", className = "", children, ...rest },
  ref,
) {
  const base =
    "appearance-none border border-ink-hairline bg-ink-surface pl-2 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:text-sm";
  return (
    <span className="relative inline-flex">
      <select ref={ref} className={`${base} ${variants[variant]} ${className}`.trim()} {...rest}>
        {children}
      </select>
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 right-0 flex items-center ${
          variant === "compact" ? "w-7" : "w-8"
        } border-l border-ink-hairline text-foreground/70`}
      >
        <svg
          viewBox="0 0 12 8"
          className={variant === "compact" ? "mx-auto h-2 w-3" : "mx-auto h-2.5 w-3.5"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 2.5 6 6.5 10 2.5" />
        </svg>
      </span>
    </span>
  );
});
