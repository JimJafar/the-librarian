// Shared input-validation helper for the three conv_state tools. The
// MCP layer raises JSON-RPC errors by throwing; centralising the
// non-empty-string assertion here means all three handlers return the
// same failure shape for the same precondition.

export function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}
