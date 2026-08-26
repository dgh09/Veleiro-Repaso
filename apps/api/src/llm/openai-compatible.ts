import { z } from "zod";

import type {
  LlmClient,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmResult,
  LlmToolCall,
  ReasoningEffort,
} from "./types";

/**
 * One HTTP attempt against an OpenAI-compatible /chat/completions endpoint.
 *
 * Deliberately has no retry logic: `withRetry` in ./retry.ts wraps this from
 * the outside, so that the instrumentation sitting between them records every
 * attempt rather than only the last one. See ./factory.ts for the ordering.
 */

/**
 * The response is model output crossing a boundary, so it is parsed before
 * anything reads it (CLAUDE.md rule 5). A provider that changes shape gives us
 * a typed `malformed_response`, not a TypeError three frames away.
 *
 * Fields we do not depend on are left off rather than declared and ignored;
 * Zod strips unknown keys by default and `raw` keeps the whole body anyway.
 */
const ToolCallSchema = z.object({
  id: z.string(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const ChatCompletionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(ToolCallSchema).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1, "the provider returned no choices"),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  defaultReasoningEffort?: ReasoningEffort;
  /** Injectable so tests can stub the network without touching globals. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY_CHARS = 500;

/**
 * Belt and braces against the one mistake that matters here.
 *
 * Nothing in this file puts headers into an error, but a misconfigured
 * LLM_BASE_URL carrying the key as a query parameter would leak it through a
 * fetch error message, and that message ends up in `llm_calls.error`. Scrubbing
 * on the way out is cheap; noticing the leak later is not.
 */
export function redactSecret(text: string, secret: string): string {
  if (secret.length < 8) return text;
  return text.split(secret).join("[redacted]");
}

/** `retry-after` is in seconds, and may be fractional. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function toWireMessage(message: LlmMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
}

function toDomainToolCalls(
  raw: z.infer<typeof ToolCallSchema>[] | undefined,
): LlmToolCall[] {
  if (!raw) return [];
  return raw.map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  }));
}

export function createOpenAiCompatibleClient(config: OpenAiCompatibleConfig): LlmClient {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const redact = (text: string): string => redactSecret(text, config.apiKey);

  return {
    async complete(request: LlmRequest): Promise<LlmResult<LlmResponse>> {
      const reasoningEffort = request.reasoningEffort ?? config.defaultReasoningEffort;

      const body: Record<string, unknown> = {
        model: config.model,
        messages: request.messages.map(toWireMessage),
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
        ...(request.maxTokens === undefined
          ? {}
          : { max_completion_tokens: request.maxTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
        ...(request.responseFormat === "json_object"
          ? { response_format: { type: "json_object" } }
          : {}),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      const elapsed = (): number => Date.now() - startedAt;

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            // The only place the key appears. It never reaches a log, an error
            // message, or `llm_calls` - that table stores the response.
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return {
          ok: false,
          error: {
            kind: "transport",
            message: redact(
              controller.signal.aborted
                ? `request aborted after ${timeoutMs}ms`
                : message,
            ),
            latencyMs: elapsed(),
          },
        };
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = elapsed();
      const text = await response.text().catch(() => "");

      if (!response.ok) {
        // 429 is a first-class outcome here, not a generic HTTP error: the free
        // tier's 8K tokens/minute makes it routine, and `withRetry` needs the
        // `retry-after` value to honour it rather than guess.
        if (response.status === 429) {
          return {
            ok: false,
            error: {
              kind: "rate_limited",
              status: response.status,
              retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
              message: redact(text.slice(0, MAX_ERROR_BODY_CHARS)),
              latencyMs,
            },
          };
        }

        return {
          ok: false,
          error: {
            kind: "http_status",
            status: response.status,
            message: redact(text.slice(0, MAX_ERROR_BODY_CHARS)),
            latencyMs,
          },
        };
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        return {
          ok: false,
          error: {
            kind: "malformed_response",
            message: "the provider returned a body that is not valid JSON",
            latencyMs,
            raw: redact(text.slice(0, MAX_ERROR_BODY_CHARS)),
          },
        };
      }

      const parsed = ChatCompletionSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            kind: "malformed_response",
            message: redact(z.prettifyError(parsed.error)),
            latencyMs,
            raw: parsedJson,
          },
        };
      }

      const choice = parsed.data.choices[0];
      /* c8 ignore next 12 */
      if (choice === undefined) {
        // Unreachable: the schema requires at least one choice. Present because
        // noUncheckedIndexedAccess is on and a non-null assertion is banned.
        return {
          ok: false,
          error: {
            kind: "malformed_response",
            message: "the provider returned no choices",
            latencyMs,
            raw: parsedJson,
          },
        };
      }

      return {
        ok: true,
        value: {
          model: parsed.data.model ?? config.model,
          content: choice.message.content ?? null,
          toolCalls: toDomainToolCalls(choice.message.tool_calls),
          finishReason: choice.finish_reason ?? "unknown",
          usage: {
            inputTokens: parsed.data.usage?.prompt_tokens ?? 0,
            outputTokens: parsed.data.usage?.completion_tokens ?? 0,
          },
          latencyMs,
          raw: parsedJson,
        },
      };
    },
  };
}
