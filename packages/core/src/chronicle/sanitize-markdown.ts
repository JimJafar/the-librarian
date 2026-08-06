/**
 * Make model-authored Markdown passive when it is written into the vault.
 *
 * Links remain links (and therefore require an explicit click), but image/embed
 * syntax and raw HTML are rendered as text. Encoding rather than deleting keeps
 * the narrator's meaning inspectable without allowing a Chronicle view to make
 * a third-party request.
 */
export function sanitizeChronicleMarkdown(value: string): string {
  return value.replaceAll("![", "&#33;[").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
