// Worker-host tests — drive the message protocol and queue semantics
// via a stub `WorkerHandle`. No `node:worker_threads` involvement.

import { describe, expect, it } from "vitest";
import {
  createInferenceClientFromHandle,
  type WorkerHandle,
} from "../src/providers/local-worker-host.js";
import type { WorkerInbound, WorkerOutbound } from "../src/providers/local.worker.js";

/**
 * Drain pending microtasks. The host pipelines through several
 * `await`s before posting messages; tests wait for those microtasks
 * to settle before asserting on `posts`.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function stubHandle(): {
  handle: WorkerHandle;
  posts: WorkerInbound[];
  emit: (msg: WorkerOutbound) => void;
  terminated: () => boolean;
} {
  const listeners = new Set<(msg: WorkerOutbound) => void>();
  const posts: WorkerInbound[] = [];
  let terminated = false;
  return {
    handle: {
      postMessage: (msg) => posts.push(msg),
      on: (_event, listener) => listeners.add(listener),
      off: (_event, listener) => listeners.delete(listener),
      terminate: async () => {
        terminated = true;
      },
    },
    posts,
    emit: (msg) => {
      for (const listener of [...listeners]) listener(msg);
    },
    terminated: () => terminated,
  };
}

function lastClassifyId(posts: WorkerInbound[]): number {
  const last = [...posts].reverse().find((p) => p.type === "classify");
  if (!last || last.type !== "classify") {
    throw new Error("no classify message posted yet");
  }
  return last.id;
}

describe("createInferenceClientFromHandle", () => {
  it("loads the model lazily on first infer() and reuses the load", async () => {
    const { handle, posts, emit } = stubHandle();
    const client = createInferenceClientFromHandle(handle, {
      modelId: "lfm2.5-1.2b-instruct",
      hfRepo: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
    });

    const inflight = client.infer("first prompt", new AbortController().signal);
    await flush();
    expect(posts[0]).toEqual({
      type: "load",
      modelId: "lfm2.5-1.2b-instruct",
      hfRepo: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
    });

    emit({ type: "ready" });
    await flush();
    expect(posts.filter((p) => p.type === "classify")).toHaveLength(1);
    const id = lastClassifyId(posts);
    emit({ type: "result", id, output: '{"requires_approval": true, "is_global": false}' });
    expect(await inflight).toBe('{"requires_approval": true, "is_global": false}');

    const second = client.infer("second prompt", new AbortController().signal);
    await flush();
    expect(posts.filter((p) => p.type === "load")).toHaveLength(1);
    expect(posts.filter((p) => p.type === "classify")).toHaveLength(2);
    emit({
      type: "result",
      id: lastClassifyId(posts),
      output: '{"requires_approval": false, "is_global": false}',
    });
    expect(await second).toBe('{"requires_approval": false, "is_global": false}');
  });

  it("serializes concurrent infer() calls — the second post does not fire until the first resolves", async () => {
    const { handle, posts, emit } = stubHandle();
    const client = createInferenceClientFromHandle(handle, { modelId: "test-model" });

    const a = client.infer("A", new AbortController().signal);
    await flush();
    emit({ type: "ready" });
    await flush();
    expect(posts.filter((p) => p.type === "classify")).toHaveLength(1);
    const aId = lastClassifyId(posts);

    const b = client.infer("B", new AbortController().signal);
    await flush();
    // B has not been posted — A is still inflight.
    expect(posts.filter((p) => p.type === "classify")).toHaveLength(1);

    emit({ type: "result", id: aId, output: "A-result" });
    expect(await a).toBe("A-result");

    await flush();
    expect(posts.filter((p) => p.type === "classify")).toHaveLength(2);
    emit({ type: "result", id: lastClassifyId(posts), output: "B-result" });
    expect(await b).toBe("B-result");
  });

  it("on abort: host promise rejects, but next infer() waits for the late worker reply before posting", async () => {
    const { handle, posts, emit } = stubHandle();
    const client = createInferenceClientFromHandle(handle, { modelId: "test-model" });

    const ctrl = new AbortController();
    const a = client.infer("A", ctrl.signal);
    await flush();
    emit({ type: "ready" });
    await flush();
    expect(posts.filter((p) => p.type === "classify")).toHaveLength(1);
    const aId = lastClassifyId(posts);

    ctrl.abort();
    await expect(a).rejects.toThrow(/aborted/);

    const b = client.infer("B", new AbortController().signal);
    await flush();
    // Critical: B must NOT have been posted yet — the worker is still
    // generating the late A reply.
    expect(posts.filter((p) => p.type === "classify")).toHaveLength(1);

    emit({ type: "result", id: aId, output: "late-A" });
    await flush();
    expect(posts.filter((p) => p.type === "classify")).toHaveLength(2);
    emit({ type: "result", id: lastClassifyId(posts), output: "B-result" });
    expect(await b).toBe("B-result");
  });

  it("terminates the worker on load_failed and rejects subsequent infer() with 'worker terminated'", async () => {
    const { handle, emit, terminated } = stubHandle();
    const client = createInferenceClientFromHandle(handle, { modelId: "bad-model" });

    const first = client.infer("p", new AbortController().signal);
    await flush();
    emit({ type: "error", kind: "load_failed", message: "could not download" });
    await expect(first).rejects.toThrow(/model load failed/);
    expect(terminated()).toBe(true);

    await expect(client.infer("p2", new AbortController().signal)).rejects.toThrow(
      /worker terminated/,
    );
  });

  it("forwards an inference-failure error from the worker to the caller", async () => {
    const { handle, posts, emit } = stubHandle();
    const client = createInferenceClientFromHandle(handle, { modelId: "test-model" });

    const inflight = client.infer("p", new AbortController().signal);
    await flush();
    emit({ type: "ready" });
    await flush();
    const id = lastClassifyId(posts);
    emit({ type: "error", id, kind: "inference_failed", message: "OOM" });
    await expect(inflight).rejects.toThrow(/inference_failed: OOM/);
  });

  it("terminate() shuts the worker down and blocks subsequent infer()", async () => {
    const { handle, terminated } = stubHandle();
    const client = createInferenceClientFromHandle(handle, { modelId: "test-model" });
    await client.terminate();
    expect(terminated()).toBe(true);
    await expect(client.infer("p", new AbortController().signal)).rejects.toThrow(
      /worker terminated/,
    );
  });
});
