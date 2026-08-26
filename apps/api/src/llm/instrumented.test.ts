import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@veleiro/shared";

import { fakeLlmClient, says } from "../../test/fake-llm";
import { pool } from "../db/client";
import { listLlmCalls } from "../db/repositories/llm-calls";
import { SEED, seed } from "../db/seed";
import { instrumented } from "./instrumented";
import type { LlmResponse, LlmResult } from "./types";

/**
 * Integration, against the real test database.
 *
 * SPEC's Phase 2 acceptance says "running any agent leaves rows in llm_calls".
 * No agent exists until Phase 3, so this is the honest version of that check:
 * the instrumentation writes a real row through the real repository, for a
 * successful call and for a failed one.
 */

const A: TenantContext = {
  tenantId: SEED.northwind.id,
  userId: SEED.northwind.users[0].id,
};
const B: TenantContext = {
  tenantId: SEED.meridian.id,
  userId: SEED.meridian.users[0].id,
};

const request = { messages: [{ role: "user" as const, content: "hello" }] };

/** A unique agent name per test, so assertions cannot pick up another test's row. */
function uniqueAgent(label: string): string {
  return `test-${label}-${randomUUID()}`;
}

async function findRow(ctx: TenantContext, agent: string) {
  const rows = await listLlmCalls(ctx, 200);
  return rows.find((row) => row.agent === agent);
}

const failure: LlmResult<LlmResponse> = {
  ok: false,
  error: { kind: "http_status", status: 502, message: "upstream exploded", latencyMs: 42 },
};

beforeAll(async () => {
  await seed();
});

afterAll(async () => {
  await pool.end();
});

describe("instrumented", () => {
  it("writes an llm_calls row for a successful call", async () => {
    const agent = uniqueAgent("success");

    const result = await instrumented(fakeLlmClient([says("hi")]), {
      ctx: A,
      agent,
      promptVersion: "smoke.v1",
      model: "test-model",
    }).complete(request);

    expect(result.ok).toBe(true);

    const row = await findRow(A, agent);
    expect(row).toBeDefined();
    expect(row?.promptVersion).toBe("smoke.v1");
    expect(row?.model).toBe("test-model");
    expect(row?.inputTokens).toBe(10);
    expect(row?.outputTokens).toBe(5);
    expect(row?.error).toBeNull();
    // numeric comes back as a string on purpose: this column is money.
    expect(row?.costUsd).toBe("0.000000");
  });

  it("writes an llm_calls row for a failed call too, which is the interesting case", async () => {
    const agent = uniqueAgent("failure");

    const result = await instrumented(fakeLlmClient([failure]), {
      ctx: A,
      agent,
      promptVersion: "smoke.v1",
      model: "test-model",
    }).complete(request);

    expect(result.ok).toBe(false);

    const row = await findRow(A, agent);
    expect(row).toBeDefined();
    expect(row?.error).toContain("502");
    expect(row?.inputTokens).toBe(0);
    expect(row?.latencyMs).toBe(42);
  });

  it("records the call against the calling tenant and no other", async () => {
    const agent = uniqueAgent("isolation");

    await instrumented(fakeLlmClient([says("hi")]), {
      ctx: A,
      agent,
      promptVersion: "smoke.v1",
      model: "test-model",
    }).complete(request);

    expect(await findRow(A, agent)).toBeDefined();
    // The same read from the other tenant's context cannot see it.
    expect(await findRow(B, agent)).toBeUndefined();
  });

  it("fails the call when a successful response cannot be audited", async () => {
    // Rule 3 says every model call is logged. A system that cannot honour that
    // has lost the guarantee, so this surfaces as a failure rather than a
    // warning - and carries the response so the tokens are not thrown away.
    const client = instrumented(fakeLlmClient([says("hi")]), {
      ctx: A,
      agent: uniqueAgent("unlogged"),
      promptVersion: "smoke.v1",
      model: "test-model",
      record: async () => ({ ok: false, error: new Error("disk is full") }),
    });

    const result = await client.complete(request);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("not_logged");
    if (result.error.kind !== "not_logged") throw new Error("unreachable");
    expect(result.error.message).toBe("disk is full");
    expect(result.error.response.content).toBe("hi");
  });

  it("still returns the provider error when a failed call cannot be audited", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const client = instrumented(fakeLlmClient([failure]), {
      ctx: A,
      agent: uniqueAgent("unlogged-failure"),
      promptVersion: "smoke.v1",
      model: "test-model",
      record: async () => ({ ok: false, error: new Error("disk is full") }),
    });

    const result = await client.complete(request);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The provider error is the actionable one; swapping it for a database
    // error would send whoever is debugging to the wrong system.
    expect(result.error.kind).toBe("http_status");
    expect(errorSpy).toHaveBeenCalledOnce();

    errorSpy.mockRestore();
  });
});
