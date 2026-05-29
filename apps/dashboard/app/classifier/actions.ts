"use server";

import type { ClassifierConfigPatch, ClassifierConfig } from "@librarian/core";
import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

export type SaveConfigResult =
  | { ok: true; config: ClassifierConfig }
  | { ok: false; error: string };
export type RestartResult =
  | {
      ok: true;
      outcome: "started" | "stopped" | "restarted" | "already_in_progress" | "failed";
      runningConfigHash: string | null;
      reason?: string;
    }
  | { ok: false; error: string };
export type SelfTestResult =
  | {
      ok: true;
      outcome: "ok" | "fallback" | "error";
      latencyMs: number;
      providerMode: "remote" | "local" | null;
      verdict?: { requires_approval: boolean; is_global: boolean };
      fallbackReason?: string;
      error?: string;
      rawOutput?: string;
    }
  | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Save the classifier config. An empty token field leaves the stored
// token unchanged (the form never round-trips the secret); send "" to
// clear.
export async function saveClassifierConfigAction(
  patch: ClassifierConfigPatch,
): Promise<SaveConfigResult> {
  try {
    const config = await serverTRPC.classifierConfig.setConfig.mutate(patch);
    revalidatePath("/classifier");
    return { ok: true, config: config as ClassifierConfig };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function restartClassifierWorkerAction(): Promise<RestartResult> {
  try {
    const result = await serverTRPC.classifierConfig.restartWorker.mutate();
    revalidatePath("/classifier");
    return {
      ok: true,
      outcome: result.outcome as RestartResult extends { ok: true; outcome: infer O } ? O : never,
      runningConfigHash: result.runningConfigHash,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function runClassifierSelfTestAction(): Promise<SelfTestResult> {
  try {
    const result = await serverTRPC.classifierConfig.selfTest.mutate();
    return {
      ok: true,
      outcome: result.outcome,
      latencyMs: result.latencyMs,
      providerMode: result.providerMode,
      ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
      ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.rawOutput !== undefined ? { rawOutput: result.rawOutput } : {}),
    };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
