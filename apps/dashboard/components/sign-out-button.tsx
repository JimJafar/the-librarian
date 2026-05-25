"use client";

import { signOutAction } from "@/app/actions/auth-actions";
import { Button } from "@/components/ui-v2/button";

// Rendered in the nav only when a session exists (see SiteNav). The server
// action clears the cookie and redirects to /login.
export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <Button type="submit" variant="ghost">
        Sign out
      </Button>
    </form>
  );
}
