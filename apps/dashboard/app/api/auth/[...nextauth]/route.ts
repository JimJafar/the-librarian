// Auth.js v5 route handler — re-exports the NextAuth GET/POST handlers for the
// /api/auth/* endpoints (sign-in, callback, csrf, session, sign-out).
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
