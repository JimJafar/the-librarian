import type { ActorDisplayProvider } from "../plugin.js";

const MAX_DISPLAY_LENGTH = 64;

function isUnsafeDisplayChar(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return (
    codePoint === undefined ||
    codePoint <= 0x1f ||
    codePoint === 0x7f ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * Resolve display chrome for actor ids already present in a response.
 *
 * The provider is called at most once with unique ids. Results are restricted
 * back to those ids, sanitised for an audit surface, and copied into a
 * null-prototype wire record so untrusted keys such as `constructor` stay data.
 */
export function resolveActorDisplays(
  provider: ActorDisplayProvider | undefined,
  ids: readonly string[],
): Readonly<Record<string, string>> | undefined {
  if (provider === undefined) return undefined;
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return undefined;

  let resolved: ReadonlyMap<string, string>;
  try {
    resolved = provider.resolveActorDisplays(uniqueIds);
  } catch {
    return undefined;
  }
  const wire: Record<string, string> = Object.create(null) as Record<string, string>;
  let count = 0;
  for (const id of uniqueIds) {
    const raw = resolved.get(id);
    if (raw === undefined) continue;
    const display = [...raw]
      .filter((char) => !isUnsafeDisplayChar(char))
      .slice(0, MAX_DISPLAY_LENGTH)
      .join("");
    if (display.length === 0) continue;
    wire[id] = display;
    count += 1;
  }
  return count === 0 ? undefined : wire;
}
