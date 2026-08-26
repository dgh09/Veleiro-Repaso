import { z } from "zod";

import type { LlmClient, LlmMessage, LlmRequest } from "../../llm/types";
import type { AgentFailure, AgentResult } from "./errors";
import { jsonSchemaFor } from "./tools";

/**
 * Structured output: ask for JSON, parse it with Zod, give the model exactly
 * one chance to fix what it got wrong.
 *
 * This deliberately does NOT use Groq's strict `json_schema` response format.
 * Two reasons: that mode cannot be combined with tool use, and it does not
 * exist on a local Ollama - so relying on it would make the offline fallback a
 * different code path instead of a config change. The manual route works
 * everywhere, and the Zod parse is the real guarantee either way (CLAUDE.md
 * rule 5). Strict mode can layer on top later as an optimisation.
 *
 * Never sends tools. That is enforced by the signature, not by a comment.
 */

export interface StructuredOptions<T> {
  client: LlmClient;
  schema: z.ZodType<T>;
  messages: LlmMessage[];
  request?: Omit<LlmRequest, "messages" | "tools" | "responseFormat">;
}

/** One initial attempt plus one corrective retry. SPEC asks for exactly this. */
const MAX_ATTEMPTS = 2;

const FENCED = /^\s*```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/;

/**
 * Models wrap JSON in code fences even when told not to. Stripping them in code
 * is more reliable than insisting harder in the prompt.
 */
export function stripCodeFences(text: string): string {
  const match = FENCED.exec(text);
  return (match?.[1] ?? text).trim();
}

function instructionFor(schema: z.ZodType): string {
  return [
    "Respond with a single JSON object and nothing else.",
    "Do not wrap it in code fences. Do not add any commentary before or after it.",
    "The object must validate against this JSON Schema:",
    JSON.stringify(jsonSchemaFor(schema)),
  ].join("\n");
}

export async function completeStructured<T>(
  options: StructuredOptions<T>,
): Promise<AgentResult<T>> {
  const conversation: LlmMessage[] = [
    ...options.messages,
    { role: "user", content: instructionFor(options.schema) },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await options.client.complete({
      ...options.request,
      messages: conversation,
      responseFormat: "json_object",
    });

    if (!result.ok) {
      return { ok: false, error: { kind: "llm", error: result.error } };
    }

    const raw = result.value.content ?? "";
    const candidate = stripCodeFences(raw);

    let parsedJson: unknown;
    let failure: AgentFailure;

    try {
      parsedJson = JSON.parse(candidate);

      const parsed = options.schema.safeParse(parsedJson);
      if (parsed.success) {
        return { ok: true, value: parsed.data };
      }

      failure = {
        kind: "schema_mismatch",
        issues: z.prettifyError(parsed.error),
        raw: candidate,
      };
    } catch (cause) {
      failure = {
        kind: "unparsable_output",
        message: cause instanceof Error ? cause.message : String(cause),
        raw: candidate,
      };
    }

    if (attempt === MAX_ATTEMPTS) {
      return { ok: false, error: failure };
    }

    // The retry carries the actual validation error, so the model is correcting
    // a specific problem rather than guessing at what we wanted.
    const problem =
      failure.kind === "schema_mismatch" ? failure.issues : failure.message;

    conversation.push({ role: "assistant", content: raw });
    conversation.push({
      role: "user",
      content:
        `That response was rejected: ${problem}\n` +
        `Return only the corrected JSON object.`,
    });
  }

  /* c8 ignore next 8 */
  // Unreachable: the loop returns on the final attempt. Present because
  // noImplicitReturns cannot see that.
  return {
    ok: false,
    error: {
      kind: "unparsable_output",
      message: "structured completion exhausted its attempts",
      raw: "",
    },
  };
}
