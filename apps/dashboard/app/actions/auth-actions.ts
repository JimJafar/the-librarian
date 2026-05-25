"use server";

import { signOut } from "@/auth";

// A2: owner sign-out. Server action so the session cookie is cleared server-side
// then the browser lands back on the login page.
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
