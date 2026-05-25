// D3.1: the Credentials provider's authorize logic, extracted so it's unit-testable
// without NextAuth. The store owns the password hash + lockout (auth.verifyPassword);
// authorize just calls it and maps the result to the single-owner identity. Fails
// closed (null → no session) on bad input, a failed/locked verify, or any error.

export interface OwnerCredential {
  id: string;
  name: string;
}

export async function authorizeOwnerCredentials(
  credentials: Partial<Record<string, unknown>>,
  verify: (username: string, password: string) => Promise<{ ok: boolean }>,
): Promise<OwnerCredential | null> {
  const username = typeof credentials.username === "string" ? credentials.username : "";
  const password = typeof credentials.password === "string" ? credentials.password : "";
  if (!username || !password) return null;
  try {
    const result = await verify(username, password);
    return result.ok ? { id: username, name: username } : null;
  } catch {
    return null;
  }
}
