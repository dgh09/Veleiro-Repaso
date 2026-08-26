import type { TenantContext } from "@veleiro/shared";

import {
  recordLlmCall,
  type RecordLlmCallResult,
  type RecordLlmCallInput,
} from "../db/repositories/llm-calls";
import { estimateCost } from "./pricing";
import {
  describeLlmFailure,
  type LlmClient,
  type LlmFailure,
  type LlmRequest,
  type LlmResponse,
  type LlmResult,
} from "./types";

/**
 * The decorator that makes CLAUDE.md rule 3 true by construction.
 *
 * Every call through this wrapper writes exactly one `llm_calls` row, whether
 * it succeeded or failed. Instrumentation lives here rather than inside the
 * loop or the HTTP client so that a new call site cannot forget it: the only
 * way to build a client is ./factory.ts, and llm-client-usage.test.ts fails the
 * build if anything outside src/llm/ constructs a raw one.
 *
 * What is logged: the response body, model, tokens, latency, cost.
 * What is never logged: the request headers, which is where the API key lives.
 */

export interface InstrumentationOptions {
  ctx: TenantContext;
  /** Agent identifier, e.g. "extractor". Written to `llm_calls.agent`. */
  agent: string;
  /** The `version` string exported by the prompt file. */
  promptVersion: string;
  /** Configured model, used when a failure carries no model of its own. */
  model: string;
  /** Injectable so unit tests can assert what would be written. */
  record?: (ctx: TenantContext, input: RecordLlmCallInput) => Promise<RecordLlmCallResult>;
}

function failureLatencyMs(failure: LlmFailure): number {
  return failure.kind === "not_logged" ? 0 : failure.latencyMs;
}

function failureRaw(failure: LlmFailure): unknown {
  // Only a malformed response has a body worth keeping; the rest are described
  // fully by the error text.
  return failure.kind === "malformed_response" ? failure.raw : null;
}

export function instrumented(
  inner: LlmClient,
  options: InstrumentationOptions,
): LlmClient {
  const record = options.record ?? recordLlmCall;

  return {
    async complete(request: LlmRequest): Promise<LlmResult<LlmResponse>> {
      const result = await inner.complete(request);

      if (!result.ok) {
        const failure = result.error;
        const written = await record(options.ctx, {
          agent: options.agent,
          promptVersion: options.promptVersion,
          model: options.model,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: estimateCost(options.model, { inputTokens: 0, outputTokens: 0 }).costUsd,
          latencyMs: failureLatencyMs(failure),
          rawResponse: failureRaw(failure),
          error: describeLlmFailure(failure),
        });

        if (!written.ok) {
          // The provider error is the actionable one and it is already being
          // returned - nothing is swallowed. Replacing it with a database error
          // would point whoever is debugging at the wrong system entirely, so
          // the lost row is reported alongside rather than instead.
          console.error(
            `[llm] failed call could not be recorded in llm_calls: ${written.error.message}`,
          );
        }

        return result;
      }

      const response = result.value;
      const cost = estimateCost(response.model, response.usage);

      const written = await record(options.ctx, {
        agent: options.agent,
        promptVersion: options.promptVersion,
        model: response.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costUsd: cost.costUsd,
        latencyMs: response.latencyMs,
        rawResponse: response.raw,
        error: null,
      });

      if (!written.ok) {
        // A successful call that cannot be audited is a failure of the system's
        // central promise, so it is surfaced as one rather than logged and
        // waved through. The response travels inside the error so the tokens
        // already paid for are not thrown away.
        return {
          ok: false,
          error: {
            kind: "not_logged",
            message: written.error.message,
            response,
          },
        };
      }

      return result;
    },
  };
}
