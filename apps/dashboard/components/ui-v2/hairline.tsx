// 1px-at-12%-opacity rule used in place of solid borders.
//
// Editorial direction calls for hairlines over heavier separators.
// One element so the rest of the redesign can drop these in lists,
// inspectors, and the top-bar bottom edge without re-declaring opacity.

import type { HTMLAttributes } from "react";

export function Hairline({ className = "", ...rest }: HTMLAttributes<HTMLHRElement>) {
  return (
    <hr className={`my-0 h-px w-full border-0 bg-foreground/10 ${className}`.trim()} {...rest} />
  );
}
