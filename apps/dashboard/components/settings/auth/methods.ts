// Shared method vocabulary for the auth surface. Keeps the labelled strings
// out of every component and pins the AuthMethod enum to the same shape the
// /packages/core auth-config exposes.

export type AuthMethod = "password" | "github" | "google";

const LABELS: Record<AuthMethod, string> = {
  password: "Password",
  github: "GitHub",
  google: "Google",
};

export function labelForMethod(method: AuthMethod): string {
  return LABELS[method];
}
