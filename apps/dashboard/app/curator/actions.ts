"use server";

import type {
  ConsumerConfig,
  ConsumerConfigPatch,
  CuratorConfigPatch,
  CuratorConsumer,
  CuratorTickResult,
  LlmProvider,
  LlmProviderInput,
  LlmProviderPatch,
} from "@librarian/core";
import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

export type RunNowResult = { ok: true; result: CuratorTickResult } | { ok: false; error: string };

export type SaveConfigResult = { ok: true } | { ok: false; error: string };

// Provider mutations return the fresh provider list / consumer config so the
// client can update without an extra round-trip; the page also revalidates.
export type ProviderListResult =
  | { ok: true; providers: LlmProvider[] }
  | { ok: false; error: string };
export type ConsumerConfigResult =
  | { ok: true; config: ConsumerConfig }
  | { ok: false; error: string };
export type ModelsResult = { models: string[] };
export type TestConnectionResult = { ok: boolean; error?: string };

/** Inline `{ endpoint, token }` draft OR a saved `providerId` for a model probe. */
export type ProbeInput = { providerId?: string; endpoint?: string; token?: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Admin run-now (§12) — shares the scheduler enqueue path via the curator router.
export async function runCuratorNowAction(): Promise<RunNowResult> {
  try {
    const result = await serverTRPC.curator.runNow.mutate();
    revalidatePath("/curator");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Save the curator config (§7.1). An empty token field leaves the stored token
// unchanged (the form never round-trips the secret); send "" explicitly to clear.
export async function saveCuratorConfigAction(
  patch: CuratorConfigPatch,
): Promise<SaveConfigResult> {
  try {
    await serverTRPC.curator.setConfig.mutate(patch);
    revalidatePath("/curator");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- LLM provider CRUD (spec 042 §4, B4b) -------------------------------------
// The token is write-only: an empty/omitted token on add or update leaves the
// stored secret untouched — the form never round-trips it.

export async function addProviderAction(input: LlmProviderInput): Promise<ProviderListResult> {
  try {
    await serverTRPC.llm.addProvider.mutate(input);
    const providers = await serverTRPC.llm.listProviders.query();
    revalidatePath("/curator");
    return { ok: true, providers };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function updateProviderAction(
  input: { id: string } & LlmProviderPatch,
): Promise<ProviderListResult> {
  try {
    await serverTRPC.llm.updateProvider.mutate(input);
    const providers = await serverTRPC.llm.listProviders.query();
    revalidatePath("/curator");
    return { ok: true, providers };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function deleteProviderAction(id: string): Promise<ProviderListResult> {
  try {
    const providers = await serverTRPC.llm.deleteProvider.mutate({ id });
    revalidatePath("/curator");
    return { ok: true, providers };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Per-consumer (intake / grooming) provider+model selection ----------------

export async function setConsumerConfigAction(
  consumer: CuratorConsumer,
  patch: ConsumerConfigPatch,
): Promise<ConsumerConfigResult> {
  try {
    const config = await serverTRPC.llm.setConsumerConfig.mutate({ consumer, ...patch });
    revalidatePath("/curator");
    return { ok: true, config };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Model picker + connection probe (fail-soft on the server) ----------------

export async function listModelsAction(input: ProbeInput): Promise<ModelsResult> {
  try {
    return await serverTRPC.llm.listModels.query(input);
  } catch {
    // Mirror the server's fail-soft contract: an unreachable proxy/server still
    // lets the user fall back to typing a model name.
    return { models: [] };
  }
}

export async function testConnectionAction(input: ProbeInput): Promise<TestConnectionResult> {
  try {
    return await serverTRPC.llm.testConnection.query(input);
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
