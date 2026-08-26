import type { LlmClient, LlmFailure, LlmRequest, LlmResponse, LlmResult } from "./types";

/**
 * Bounded retry for the failures that are worth retrying.
 *
 * This exists because of a hard constraint, not as general-purpose resilience:
 * the Groq free tier allows 8K tokens per minute, and a Phase 6 eval run of
 * twenty transcripts will cross that repeatedly. Without this, the eval harness
 * would have to grow its own backoff.
 *
 * Placement matters. `withRetry` wraps the *instrumented* client, not the raw
 * one, so each attempt writes its own `llm_calls` row. Wrapping the other way
 * round would log only the final attempt and hide exactly the rate-limit data
 * Phase 6 needs to report. See ./factory.ts.
 */

export interface RetryOptions {
  /** Retries *after* the first attempt. 2 means at most 3 calls. */
  maxRetries?: number;
  /**
   * Refuse to sleep longer than this for any single wait. A provider that
   * answers `retry-after: 300` gets a fast, typed failure instead of stalling a
   * request - or a test - for five minutes.
   */
  maxWaitMs?: number;
  baseWaitMs?: number;
  /** Injectable so tests assert the backoff without waiting for it. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_WAIT_MS = 20_000;
const DEFAULT_BASE_WAIT_MS = 1_000;

/**
 * Rate limits and server-side faults are transient by definition. Transport
 * errors are not retried: on this budget a timeout usually means the request
 * was received and paid for, and retrying would double the token spend to get
 * the same answer.
 */
function isRetryable(failure: LlmFailure): boolean {
  if (failure.kind === "rate_limited") return true;
  if (failure.kind === "http_status") return failure.status >= 500;
  return false;
}

function waitMsFor(failure: LlmFailure, attempt: number, baseWaitMs: number): number {
  // Prefer what the provider actually told us over a guess.
  if (failure.kind === "rate_limited" && failure.retryAfterMs !== undefined) {
    return failure.retryAfterMs;
  }
  return baseWaitMs * 2 ** (attempt - 1);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function withRetry(inner: LlmClient, options: RetryOptions = {}): LlmClient {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const baseWaitMs = options.baseWaitMs ?? DEFAULT_BASE_WAIT_MS;
  const sleep = options.sleep ?? defaultSleep;

  return {
    async complete(request: LlmRequest): Promise<LlmResult<LlmResponse>> {
      for (let attempt = 1; ; attempt++) {
        const result = await inner.complete(request);
        if (result.ok) return result;

        if (attempt > maxRetries) return result;
        if (!isRetryable(result.error)) return result;

        const waitMs = waitMsFor(result.error, attempt, baseWaitMs);
        if (waitMs > maxWaitMs) return result;

        await sleep(waitMs);
      }
    },
  };
}
