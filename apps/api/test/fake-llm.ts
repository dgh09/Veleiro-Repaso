import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmResult,
  LlmToolCall,
} from "../src/llm/types";

/**
 * A scripted `LlmClient` for the unit tests.
 *
 * The suite must never touch the network: it has to be free, offline and
 * deterministic. Everything the runtime does with a model - tool sequences,
 * malformed JSON, rate limits - is expressed here as a list of canned results.
 */

export function llmResponse(partial: Partial<LlmResponse> = {}): LlmResponse {
  return {
    model: "test-model",
    content: null,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
    latencyMs: 1,
    raw: { stub: true },
    ...partial,
  };
}

export function toolCall(name: string, args: unknown, id = `call_${name}`): LlmToolCall {
  return { id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
}

export function says(content: string): LlmResult<LlmResponse> {
  return { ok: true, value: llmResponse({ content }) };
}

export function calls(...toolCalls: LlmToolCall[]): LlmResult<LlmResponse> {
  return { ok: true, value: llmResponse({ toolCalls }) };
}

export interface FakeLlmClient extends LlmClient {
  /** Every request the subject sent, snapshotted at send time. */
  readonly requests: LlmRequest[];
  readonly callCount: number;
}

/**
 * Replays `script` in order. Once exhausted it repeats the final entry, which
 * is what lets the iteration-cap test drive an endless stream of tool calls
 * without writing eight of them out.
 */
export function fakeLlmClient(script: LlmResult<LlmResponse>[]): FakeLlmClient {
  const requests: LlmRequest[] = [];
  let index = 0;

  return {
    get requests(): LlmRequest[] {
      return requests;
    },
    get callCount(): number {
      return requests.length;
    },
    async complete(request: LlmRequest): Promise<LlmResult<LlmResponse>> {
      // The loop appends to its own conversation array, so snapshot the
      // messages or every recorded request would show the final state.
      requests.push({ ...request, messages: [...request.messages] });

      const next = script[Math.min(index, script.length - 1)];
      index += 1;

      if (next === undefined) {
        throw new Error("fakeLlmClient was given an empty script");
      }

      return next;
    },
  };
}
