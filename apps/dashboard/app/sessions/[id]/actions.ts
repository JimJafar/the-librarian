"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

type ActionResult = { ok: true } | { ok: false; error: string };

function fail(message: string): ActionResult {
  return { ok: false, error: message };
}

function asString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asList(form: FormData, key: string): string[] | undefined {
  const raw = form.get(key);
  if (typeof raw !== "string") return undefined;
  const items = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function revalidateSession(id: string): void {
  revalidatePath("/sessions");
  revalidatePath(`/sessions/${id}`);
}

function lifecycleInput(sessionId: string, form: FormData) {
  return {
    session_id: sessionId,
    summary: asString(form, "summary"),
    decisions: asList(form, "decisions"),
    files_touched: asList(form, "files_touched"),
    commands_run: asList(form, "commands_run"),
    open_questions: asList(form, "open_questions"),
    next_steps: asList(form, "next_steps"),
    reason: asString(form, "reason"),
  };
}

export async function checkpointSessionAction(
  sessionId: string,
  form: FormData,
): Promise<ActionResult> {
  try {
    await serverTRPC.sessions.checkpoint.mutate(lifecycleInput(sessionId, form));
    revalidateSession(sessionId);
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function pauseSessionAction(sessionId: string, form: FormData): Promise<ActionResult> {
  try {
    await serverTRPC.sessions.pause.mutate(lifecycleInput(sessionId, form));
    revalidateSession(sessionId);
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function endSessionAction(sessionId: string, form: FormData): Promise<ActionResult> {
  try {
    await serverTRPC.sessions.end.mutate(lifecycleInput(sessionId, form));
    revalidateSession(sessionId);
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function resumeSessionAction(sessionId: string): Promise<ActionResult> {
  // S1.1: resume covers what archive/restore/delete used to do — an ended
  // session is brought back to paused via the continue tRPC procedure
  // (the projection's EventRecorded path flips it to active on the next
  // recorded event).
  try {
    await serverTRPC.sessions.continue.mutate({ session_id: sessionId, attach: false });
    revalidateSession(sessionId);
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export type ContinueResult = { ok: true; handover: unknown } | { ok: false; error: string };

type HandoverFormat = "prose" | "markdown" | "claude" | "codex" | "opencode" | "hermes" | "pi";
const ALLOWED_FORMATS: readonly HandoverFormat[] = [
  "prose",
  "markdown",
  "claude",
  "codex",
  "opencode",
  "hermes",
  "pi",
];

function resolveFormat(form: FormData): HandoverFormat {
  const raw = asString(form, "format");
  return (ALLOWED_FORMATS as readonly string[]).includes(raw ?? "")
    ? (raw as HandoverFormat)
    : "prose";
}

export async function continueSessionAction(
  sessionId: string,
  form: FormData,
): Promise<ContinueResult> {
  try {
    const handover = await serverTRPC.sessions.continue.mutate({
      session_id: sessionId,
      target_harness: asString(form, "target_harness"),
      target_cwd: asString(form, "target_cwd"),
      target_source_ref: asString(form, "target_source_ref"),
      attach: form.get("attach") === "on",
      format: resolveFormat(form),
    });
    revalidateSession(sessionId);
    return { ok: true, handover };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function promoteSessionFactAction(
  sessionId: string,
  form: FormData,
): Promise<ActionResult> {
  const title = asString(form, "memory_title");
  const body = asString(form, "memory_body");
  if (!title || !body) return fail("Memory title and body are required.");
  try {
    await serverTRPC.sessions.promote.mutate({
      session_id: sessionId,
      memory: {
        title,
        body,
        category: asString(form, "memory_category") ?? "lessons",
        visibility: asString(form, "memory_visibility") ?? "common",
        scope: asString(form, "memory_scope") ?? "global",
      },
    });
    revalidateSession(sessionId);
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
