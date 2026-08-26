import { describe, expect, it } from "vitest";
import { z } from "zod";

import { fakeLlmClient, says } from "../../../test/fake-llm";
import { completeStructured, stripCodeFences } from "./structured";

const Requirement = z.object({
  title: z.string(),
  confidence: z.number().min(0).max(1),
});

const messages = [{ role: "user" as const, content: "Extract the requirement." }];

describe("stripCodeFences", () => {
  it("unwraps a fenced block, with or without a language tag", () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves bare JSON alone", () => {
    expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("completeStructured", () => {
  it("parses a valid response on the first attempt", async () => {
    const client = fakeLlmClient([says('{"title":"Require close date","confidence":0.9}')]);

    const result = await completeStructured({ client, schema: Requirement, messages });

    expect(result).toEqual({
      ok: true,
      value: { title: "Require close date", confidence: 0.9 },
    });
    expect(client.callCount).toBe(1);
  });

  it("parses a response the model wrapped in code fences anyway", async () => {
    const client = fakeLlmClient([
      says('```json\n{"title":"Renewal risk","confidence":0.7}\n```'),
    ]);

    const result = await completeStructured({ client, schema: Requirement, messages });

    expect(result.ok).toBe(true);
    expect(client.callCount).toBe(1);
  });

  it("never sends tools, because Groq cannot combine them with JSON output", async () => {
    const client = fakeLlmClient([says('{"title":"x","confidence":0.5}')]);

    await completeStructured({ client, schema: Requirement, messages });

    expect(client.requests[0]?.tools).toBeUndefined();
    expect(client.requests[0]?.responseFormat).toBe("json_object");
  });

  it("puts the schema in front of the model so it knows the target shape", async () => {
    const client = fakeLlmClient([says('{"title":"x","confidence":0.5}')]);

    await completeStructured({ client, schema: Requirement, messages });

    const sent = client.requests[0]?.messages.at(-1);
    expect(sent?.role).toBe("user");
    expect(sent?.role === "user" ? sent.content : "").toContain("confidence");
  });

  it("retries exactly once on unparseable JSON, then succeeds", async () => {
    const client = fakeLlmClient([
      says("Sure! Here is the JSON you asked for:"),
      says('{"title":"Require close date","confidence":0.9}'),
    ]);

    const result = await completeStructured({ client, schema: Requirement, messages });

    expect(result.ok).toBe(true);
    expect(client.callCount).toBe(2);

    // The retry has to say what was wrong, or the model is guessing.
    const retry = client.requests[1]?.messages.at(-1);
    expect(retry?.role === "user" ? retry.content : "").toContain("rejected");
  });

  it("fails cleanly after the second unparseable response", async () => {
    const client = fakeLlmClient([says("still not JSON")]);

    const result = await completeStructured({ client, schema: Requirement, messages });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("unparsable_output");
    // Exactly one retry - not a loop that keeps paying for the same mistake.
    expect(client.callCount).toBe(2);
  });

  it("retries once on valid JSON that does not match the schema, then fails", async () => {
    const client = fakeLlmClient([says('{"title":"x","confidence":42}')]);

    const result = await completeStructured({ client, schema: Requirement, messages });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("schema_mismatch");
    if (result.error.kind !== "schema_mismatch") throw new Error("unreachable");
    expect(result.error.issues).toContain("confidence");
    expect(client.callCount).toBe(2);
  });

  it("surfaces a model failure as a typed value", async () => {
    const client = fakeLlmClient([
      {
        ok: false,
        error: {
          kind: "rate_limited",
          status: 429,
          retryAfterMs: 2000,
          message: "slow down",
          latencyMs: 5,
        },
      },
    ]);

    const result = await completeStructured({ client, schema: Requirement, messages });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("llm");
    // A rate limit is not a parse problem, so it does not consume the retry.
    expect(client.callCount).toBe(1);
  });
});
