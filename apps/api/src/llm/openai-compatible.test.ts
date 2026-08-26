import { describe, expect, it, vi } from "vitest";

import { createOpenAiCompatibleClient, redactSecret } from "./openai-compatible";
import type { LlmRequest } from "./types";

const API_KEY = "gsk_test_0123456789abcdefghijklmnop";

function clientReturning(body: string, init: ResponseInit = { status: 200 }) {
  const fetchImpl = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(body, init),
  );
  const client = createOpenAiCompatibleClient({
    baseUrl: "https://api.example.test/openai/v1",
    apiKey: API_KEY,
    model: "openai/gpt-oss-120b",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { complete: (r: LlmRequest) => client.complete(r), fetchImpl };
}

const ask: LlmRequest = { messages: [{ role: "user", content: "hello" }] };

const okBody = JSON.stringify({
  model: "openai/gpt-oss-120b",
  choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 4 },
});

describe("createOpenAiCompatibleClient", () => {
  it("parses a successful completion", async () => {
    const { complete } = clientReturning(okBody);

    const result = await complete(ask);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.content).toBe("hi there");
    expect(result.value.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
    expect(result.value.model).toBe("openai/gpt-oss-120b");
    expect(result.value.finishReason).toBe("stop");
  });

  it("posts to /chat/completions with the key in the Authorization header", async () => {
    const { complete, fetchImpl } = clientReturning(okBody);

    await complete(ask);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/openai/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${API_KEY}`,
    );
  });

  it("sends reasoning_effort, which is a token budget control on gpt-oss", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(okBody, { status: 200 }));
    const client = createOpenAiCompatibleClient({
      baseUrl: "https://api.example.test/v1",
      apiKey: API_KEY,
      model: "openai/gpt-oss-120b",
      defaultReasoningEffort: "low",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.complete(ask);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ reasoning_effort: "low" });
  });

  it("maps tool calls out of the provider's shape", async () => {
    const { complete } = clientReturning(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup_object", arguments: '{"name":"Lead"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    const result = await complete(ask);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.toolCalls).toEqual([
      { id: "call_1", name: "lookup_object", arguments: '{"name":"Lead"}' },
    ]);
  });

  it("treats 429 as its own outcome and carries retry-after through", async () => {
    const { complete } = clientReturning("rate limit reached", {
      status: 429,
      headers: { "retry-after": "2.5" },
    });

    const result = await complete(ask);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("rate_limited");
    if (result.error.kind !== "rate_limited") throw new Error("unreachable");
    expect(result.error.retryAfterMs).toBe(2500);
  });

  it("reports a rate limit with no retry-after as an unknown wait, not zero", async () => {
    const { complete } = clientReturning("slow down", { status: 429 });

    const result = await complete(ask);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.error.kind !== "rate_limited") throw new Error("unreachable");
    expect(result.error.retryAfterMs).toBeUndefined();
  });

  it("returns a typed failure for a server error", async () => {
    const { complete } = clientReturning("upstream exploded", { status: 502 });

    const result = await complete(ask);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatchObject({ kind: "http_status", status: 502 });
  });

  it("returns a typed failure when the body is not JSON, rather than throwing", async () => {
    const { complete } = clientReturning("<html>gateway timeout</html>");

    const result = await complete(ask);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("malformed_response");
  });

  it("returns a typed failure when the JSON does not match the expected shape", async () => {
    const { complete } = clientReturning(JSON.stringify({ choices: [] }));

    const result = await complete(ask);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("malformed_response");
  });

  it("never lets the API key reach an error message", async () => {
    // The worst case: a transport error whose text contains the credential.
    // Whatever produced it, this message is headed for llm_calls.error.
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => {
      throw new Error(`connect ECONNREFUSED using key ${API_KEY}`);
    });
    const client = createOpenAiCompatibleClient({
      baseUrl: "https://api.example.test/v1",
      apiKey: API_KEY,
      model: "openai/gpt-oss-120b",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.complete(ask);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.error.kind !== "transport") throw new Error("unreachable");
    expect(result.error.message).not.toContain(API_KEY);
    expect(result.error.message).toContain("[redacted]");
  });
});

describe("redactSecret", () => {
  it("replaces every occurrence", () => {
    expect(redactSecret(`a ${API_KEY} b ${API_KEY}`, API_KEY)).toBe(
      "a [redacted] b [redacted]",
    );
  });

  it("refuses to redact a short string, which would blank out ordinary text", () => {
    expect(redactSecret("the cat sat", "cat")).toBe("the cat sat");
  });
});
