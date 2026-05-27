"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

export type ClassifierEvalActionResult =
  | { ok: true; report: ClassifierEvalReportSummary }
  | { ok: false; error: string };

export interface ClassifierEvalReportSummary {
  run_id: string;
  provider: string;
  model: string;
  prompt_version: string;
  sample_size: number;
  filter: string;
  agreement: { joint: number; requires_approval: number; is_global: number };
  fallback_counts: Record<string, number>;
  latency_ms: { p50: number; p95: number; p99: number; max: number };
}

function field(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runClassifierEvalAction(form: FormData): Promise<ClassifierEvalActionResult> {
  try {
    const endpoint = field(form, "endpoint");
    const token = field(form, "token");
    const model = field(form, "model");
    const category = field(form, "category") ?? "all";
    const sampleRaw = field(form, "sample") ?? "10";

    if (!endpoint) return { ok: false, error: "Endpoint URL is required." };
    if (!token) return { ok: false, error: "API token is required." };
    if (!model) return { ok: false, error: "Model id is required." };
    if (category !== "all" && category !== "straight" && category !== "boundary") {
      return { ok: false, error: "Category must be all, straight, or boundary." };
    }
    const sample = Number(sampleRaw);
    if (!Number.isFinite(sample) || sample <= 0 || sample > 1000) {
      return { ok: false, error: "Sample size must be between 1 and 1000." };
    }

    const report = await serverTRPC.classifierEval.runEval.mutate({
      provider: "remote",
      endpoint,
      token,
      model,
      sample,
      category,
    });
    revalidatePath("/classifier-eval");
    return {
      ok: true,
      report: {
        run_id: report.run_id,
        provider: report.provider,
        model: report.model,
        prompt_version: report.prompt_version,
        sample_size: report.sample_size,
        filter: report.filter,
        agreement: report.agreement,
        fallback_counts: report.fallback_counts,
        latency_ms: report.latency_ms,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
