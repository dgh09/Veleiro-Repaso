import { describe, expect, it } from "vitest";

import { fakeLlmClient, says } from "../../test/fake-llm";
import { withRetry } from "./retry";
import type { LlmResponse, LlmResult } from "./types";

function rateLimited(retryAfterMs: number | undefined): LlmResult<LlmResponse> {
  return {
    ok: false,
    error: {
      kind: "rate_limited",
      status: 429,
      retryAfterMs,
      message: "too many requests",
      latencyMs: 3,
    },
  };
}

function httpStatus(status: number): LlmResult<LlmResponse> {
  return {
    ok: false,
    error: { kind: "http_status", status, message: "boom", latencyMs: 3 },
  };
}

/** Records what would have been slept instead of actually sleeping. */
function recordingSleep(): { slept: number[]; sleep: (ms: number) => Promise<void> } {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

const request = { messages: [{ role: "user" as const, content: "hi" }] };

describe("withRetry", () => {
  it("retries a rate limit and returns the eventual success", async () => {
    const { slept, sleep } = recordingSleep();
    const inner = fakeLlmClient([rateLimited(50), says("done")]);

    const result = await withRetry(inner, { sleep }).complete(request);

    expect(result.ok).toBe(true);
    expect(inner.callCount).toBe(2);
    expect(slept).toEqual([50]);
  });

  it("honours the provider's retry-after rather than guessing", async () => {
    const { slept, sleep } = recordingSleep();
    const inner = fakeLlmClient([rateLimited(7_000), says("done")]);

    await withRetry(inner, { sleep, baseWaitMs: 1_000 }).complete(request);

    expect(slept).toEqual([7_000]);
  });

  it("backs off exponentially when the provider says nothing", async () => {
    const { slept, sleep } = recordingSleep();
    const inner = fakeLlmClient([rateLimited(undefined)]);

    await withRetry(inner, { sleep, baseWaitMs: 100 }).complete(request);

    expect(slept).toEqual([100, 200]);
  });

  it("stops after the retry budget and returns the last failure", async () => {
    const { sleep } = recordingSleep();
    const inner = fakeLlmClient([rateLimited(10)]);

    const result = await withRetry(inner, { sleep, maxRetries: 2 }).complete(request);

    expect(result.ok).toBe(false);
    // One initial attempt plus two retries.
    expect(inner.callCount).toBe(3);
  });

  it("refuses to sleep through an absurd retry-after", async () => {
    const { slept, sleep } = recordingSleep();
    const inner = fakeLlmClient([rateLimited(300_000)]);

    const result = await withRetry(inner, { sleep, maxWaitMs: 20_000 }).complete(request);

    expect(result.ok).toBe(false);
    // Fails fast instead of stalling the request - or the test suite - for five
    // minutes.
    expect(inner.callCount).toBe(1);
    expect(slept).toEqual([]);
  });

  it("retries a server-side fault", async () => {
    const { sleep } = recordingSleep();
    const inner = fakeLlmClient([httpStatus(503), says("done")]);

    const result = await withRetry(inner, { sleep }).complete(request);

    expect(result.ok).toBe(true);
    expect(inner.callCount).toBe(2);
  });

  it("does not retry a client error, which would fail identically", async () => {
    const { sleep } = recordingSleep();
    const inner = fakeLlmClient([httpStatus(400)]);

    const result = await withRetry(inner, { sleep }).complete(request);

    expect(result.ok).toBe(false);
    expect(inner.callCount).toBe(1);
  });

  it("does not retry a transport error, which may already have been billed", async () => {
    const { sleep } = recordingSleep();
    const inner = fakeLlmClient([
      { ok: false, error: { kind: "transport", message: "socket hang up", latencyMs: 9 } },
    ]);

    await withRetry(inner, { sleep }).complete(request);

    expect(inner.callCount).toBe(1);
  });
});
