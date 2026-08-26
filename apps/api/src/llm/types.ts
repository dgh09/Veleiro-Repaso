/**
 * The wire contract for talking to an OpenAI-compatible /chat/completions
 * endpoint, expressed in our own vocabulary rather than the provider's.
 *
 * Two reasons it is not just the provider's shape re-exported:
 *
 * 1. CLAUDE.md forbids a vendor SDK, so the boundary is ours to define. Keeping
 *    snake_case wire fields out of the domain means swapping Groq for a local
 *    Ollama is a config change, as intended.
 * 2. Errors are values at boundaries. Every call returns an `LlmResult`, so a
 *    caller cannot forget that the model is a network dependency that fails.
 */

/** A tool as the model sees it. `parameters` is JSON Schema. */
export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /**
   * The raw JSON string the model produced. Deliberately left unparsed here:
   * parsing it is the tool registry's job, because that is where the Zod schema
   * lives and where a parse failure can be handed back to the model.
   */
  arguments: string;
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/**
 * gpt-oss models bill reasoning tokens as output tokens, so on an 8K
 * tokens/minute free tier this is a budget control, not a quality dial.
 */
export type ReasoningEffort = "low" | "medium" | "high";

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  /**
   * `json_object` asks for syntactically valid JSON. Note this is NOT Groq's
   * strict `json_schema` mode: that one cannot be combined with tools, so we
   * stay on the portable path that also works against Ollama.
   */
  responseFormat?: "text" | "json_object";
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  model: string;
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: string;
  usage: LlmUsage;
  latencyMs: number;
  /** The parsed response body, as written to `llm_calls.raw_response`. */
  raw: unknown;
}

/**
 * Every variant carries `latencyMs` because failed calls are logged too
 * (CLAUDE.md rule 3) and a failure that took 30 seconds is a different problem
 * from one that took 30 milliseconds.
 */
export type LlmFailure =
  | { kind: "transport"; message: string; latencyMs: number }
  | { kind: "http_status"; status: number; message: string; latencyMs: number }
  | {
      kind: "rate_limited";
      status: number;
      retryAfterMs: number | undefined;
      message: string;
      latencyMs: number;
    }
  | { kind: "malformed_response"; message: string; latencyMs: number; raw: unknown }
  /**
   * The model answered but the `llm_calls` row could not be written.
   *
   * This is a failure rather than a warning on purpose. Rule 3 says every model
   * call is logged; a system that cannot honour that has lost the audit
   * guarantee, and "log the problem and carry on" is exactly what CLAUDE.md
   * rules out. The response is carried along so nothing paid for is thrown
   * away silently.
   */
  | { kind: "not_logged"; message: string; response: LlmResponse };

export type LlmResult<T> = { ok: true; value: T } | { ok: false; error: LlmFailure };

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResult<LlmResponse>>;
}

export function describeLlmFailure(failure: LlmFailure): string {
  switch (failure.kind) {
    case "transport":
      return `transport: ${failure.message}`;
    case "http_status":
      return `http ${failure.status}: ${failure.message}`;
    case "rate_limited":
      return `rate limited (http ${failure.status}): ${failure.message}`;
    case "malformed_response":
      return `malformed response: ${failure.message}`;
    case "not_logged":
      return `not logged: ${failure.message}`;
  }
}
