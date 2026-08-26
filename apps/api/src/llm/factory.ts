import type { TenantContext } from "@veleiro/shared";

import { env } from "../env";
import { instrumented } from "./instrumented";
import { createOpenAiCompatibleClient } from "./openai-compatible";
import { withRetry, type RetryOptions } from "./retry";
import type { LlmClient, ReasoningEffort } from "./types";

/**
 * The single place an LLM client is assembled.
 *
 * The composition order is the load-bearing decision in this whole layer:
 *
 *     withRetry( instrumented( raw ) )
 *
 * Retry on the outside means each attempt passes through instrumentation and
 * gets its own `llm_calls` row. The other order - instrumenting the retrying
 * client - would record one row for what was really three calls, hiding the
 * 429s that the Groq free tier produces routinely and that Phase 6 has to
 * report on.
 *
 * Everything downstream receives a plain `LlmClient` and knows nothing about
 * tenants, retries or logging.
 */

export interface AgentLlmClientOptions {
  ctx: TenantContext;
  /** Agent identifier written to `llm_calls.agent`, e.g. "extractor". */
  agent: string;
  /** The `version` string exported by the prompt file being used. */
  promptVersion: string;
  /**
   * Defaults to "low". On gpt-oss models reasoning tokens bill as output, and
   * the free tier allows 8K tokens per minute, so this is a budget decision
   * before it is a quality one.
   */
  reasoningEffort?: ReasoningEffort;
  retry?: RetryOptions;
}

export function createAgentLlmClient(options: AgentLlmClientOptions): LlmClient {
  const raw = createOpenAiCompatibleClient({
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    defaultReasoningEffort: options.reasoningEffort ?? "low",
  });

  const logged = instrumented(raw, {
    ctx: options.ctx,
    agent: options.agent,
    promptVersion: options.promptVersion,
    model: env.LLM_MODEL,
  });

  return withRetry(logged, options.retry);
}
