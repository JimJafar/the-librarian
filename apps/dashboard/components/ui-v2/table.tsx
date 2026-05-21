// U1 — editorial Table.
//
// 28–32px row height (per dashboard-redesign spec), 13px body / 11px
// mono, hairline row separators at 12% opacity, no card chrome.
// Selection state surfaces through `data-state="selected"` on TableRow
// — consumers set it on the row and the styling responds. Sub-component
// names match the legacy shadcn shape for drop-in compatibility.

import {
  forwardRef,
  type HTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";

export const Table = forwardRef<HTMLTableElement, HTMLAttributes<HTMLTableElement>>(function Table(
  { className = "", ...props },
  ref,
) {
  return (
    <div className="relative w-full overflow-auto">
      <table
        ref={ref}
        className={`w-full border-collapse caption-bottom text-[13px] font-sans text-foreground ${className}`.trim()}
        {...props}
      />
    </div>
  );
});

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className = "", ...props }, ref) {
  return (
    <thead
      ref={ref}
      className={`border-b border-ink-hairline text-[11px] uppercase tracking-wider text-foreground/60 ${className}`.trim()}
      {...props}
    />
  );
});

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className = "", ...props }, ref) {
  return <tbody ref={ref} className={className} {...props} />;
});

export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  function TableRow({ className = "", ...props }, ref) {
    return (
      <tr
        ref={ref}
        className={`border-b border-ink-hairline transition-colors hover:bg-foreground/[0.03] data-[state=selected]:bg-ink-accent/[0.08] ${className}`.trim()}
        {...props}
      />
    );
  },
);

export const TableHead = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(
  function TableHead({ className = "", ...props }, ref) {
    return (
      <th
        ref={ref}
        className={`h-8 px-2 text-left align-middle font-medium ${className}`.trim()}
        {...props}
      />
    );
  },
);

export const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(
  function TableCell({ className = "", ...props }, ref) {
    return <td ref={ref} className={`h-8 px-2 align-middle ${className}`.trim()} {...props} />;
  },
);
