"use client";

const VISIBLE_TAG_LIMIT = 3;

interface MemoryTagsProps {
  tags: readonly string[];
  onSelect?: (tag: string) => void;
  className?: string;
}

export function MemoryTags({ tags, onSelect, className = "" }: MemoryTagsProps) {
  const validTags = tags.filter((tag) => typeof tag === "string" && tag.length > 0);
  if (validTags.length === 0) return null;

  const visibleTags = validTags.slice(0, VISIBLE_TAG_LIMIT);
  const hiddenCount = validTags.length - visibleTags.length;
  const pillClass =
    "inline-block max-w-48 truncate border border-foreground/15 bg-foreground/[0.035] px-1.5 py-0.5 font-mono text-[10px] leading-4 text-foreground/65";

  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`.trim()}>
      {visibleTags.map((tag, index) =>
        onSelect ? (
          <button
            key={`${tag}-${index}`}
            type="button"
            data-testid="memory-tag"
            title={tag}
            aria-label={`Filter by tag ${tag}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(tag);
            }}
            className={`${pillClass} transition-colors hover:border-ink-accent/50 hover:text-ink-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent pointer-coarse:min-h-11 pointer-coarse:px-3 pointer-coarse:py-2`}
          >
            {tag}
          </button>
        ) : (
          <span key={`${tag}-${index}`} data-testid="memory-tag" title={tag} className={pillClass}>
            {tag}
          </span>
        ),
      )}
      {hiddenCount > 0 ? (
        <span
          aria-label={`${hiddenCount} more tags`}
          className="font-mono text-[10px] leading-4 text-foreground/55"
        >
          +{hiddenCount} more
        </span>
      ) : null}
    </div>
  );
}
