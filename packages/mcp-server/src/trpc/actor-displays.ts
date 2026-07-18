import type { ActorDisplayProvider } from "../plugin.js";

const MAX_DISPLAY_LENGTH = 64;

function isUnsafeDisplayChar(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return (
    codePoint === undefined ||
    codePoint <= 0x1f ||
    codePoint === 0x7f ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    /\p{Bidi_Control}/u.test(char)
  );
}

function sanitiseDisplay(raw: string): string {
  let display = "";
  let length = 0;
  for (const char of raw) {
    if (isUnsafeDisplayChar(char)) continue;
    display += char;
    length += 1;
    if (length === MAX_DISPLAY_LENGTH) break;
  }
  return display;
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
  const allowedIds = [...new Set(ids)];
  if (allowedIds.length === 0) return undefined;

  try {
    // Give the provider its own array. TypeScript's `readonly` is not a runtime
    // boundary; a buggy provider may mutate it, but that must never widen the
    // response beyond the untouched payload-derived allow-set.
    const resolved = provider.resolveActorDisplays([...allowedIds]);
    const wire: Record<string, string> = Object.create(null) as Record<string, string>;
    let count = 0;
    for (const id of allowedIds) {
      const raw = resolved.get(id);
      if (typeof raw !== "string") continue;
      const display = sanitiseDisplay(raw);
      if (display.length === 0) continue;
      wire[id] = display;
      count += 1;
    }
    return count === 0 ? undefined : wire;
  } catch {
    return undefined;
  }
}
