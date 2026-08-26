import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TenantContext } from "@veleiro/shared";

import { fakeLlmClient, says } from "../../test/fake-llm";
import { TEST_DATABASE_NAME } from "../../test/database-url";
import { runExtractor, type ExtractOptions } from "../agents/extractor/extractor";
import { runProposer, type ProposeOptions } from "../agents/proposer/proposer";
import { createApp } from "../app";
import { db, pool } from "../db/client";
import { recordLlmCall } from "../db/repositories/llm-calls";
import { SEED, seed } from "../db/seed";

const NORTHWIND = SEED.northwind;
const MERIDIAN = SEED.meridian;

const HEADERS = { "X-Tenant-Id": NORTHWIND.id, "X-User-Id": NORTHWIND.users[0].id };
const MERIDIAN_HEADERS = {
  "X-Tenant-Id": MERIDIAN.id,
  "X-User-Id": MERIDIAN.users[0].id,
};

const ctx: TenantContext = { tenantId: NORTHWIND.id, userId: NORTHWIND.users[0].id };

const TRANSCRIPT_ID = NORTHWIND.projects[0].transcriptId;
const REAL_QUOTE = "We need the close date on the opportunity to be required";

interface Metrics {
  llm: { calls: number; inputTokens: number; outputTokens: number; costUsd: string };
  requirements: { total: number; needsReview: number; needsReviewRate: number };
  proposals: { total: number; rejected: number; approvalRate: number; rejectionRate: number };
}

function appWith(requirements: unknown[]) {
  return createApp({
    transcripts: {
      runExtractor: (o: ExtractOptions) =>
        runExtractor({
          ...o,
          client: fakeLlmClient([says(JSON.stringify({ requirements }))]),
        }),
    },
    requirements: {
      runProposer: (o: ProposeOptions) =>
        runProposer({
          ...o,
          client: fakeLlmClient([
            says(
              JSON.stringify({
                payload: {
                  changeType: "create_field",
                  objectName: "Opportunity",
                  fieldName: "X__c",
                  fieldType: "Text",
                  label: "X",
                  required: false,
                  picklistValues: null,
                },
              }),
            ),
          ]),
        }),
    },
  });
}

const CLEAN = {
  title: "Require close date",
  description: "d",
  crmObject: "Opportunity",
  fieldName: "CloseDate",
  fieldType: "Date",
  rationale: "r",
  sourceQuote: REAL_QUOTE,
  confidence: 0.9,
};
const FLAGGED = { ...CLEAN, title: "Invented", sourceQuote: "not in the transcript at all" };

beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL ?? "").pathname.replace("/", "");
  if (target !== TEST_DATABASE_NAME) {
    throw new Error(`Refusing to run destructive tests against "${target}".`);
  }
  await seed();
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table ${sql.identifier("requirements")}, ${sql.identifier("proposals")}, ${sql.identifier("audit_log")}, ${sql.identifier("llm_calls")} cascade`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/metrics", () => {
  it("reports zeros for a tenant that has done nothing, not an error", async () => {
    const res = await createApp().request("/api/metrics", { headers: HEADERS });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Metrics;
    expect(body.llm.calls).toBe(0);
    // A rate over an empty denominator is 0, not NaN - NaN does not survive JSON.
    expect(body.requirements.needsReviewRate).toBe(0);
    expect(body.proposals.approvalRate).toBe(0);
  });

  it("sums token usage and cost from llm_calls", async () => {
    await recordLlmCall(ctx, {
      agent: "extractor",
      promptVersion: "extractor.v1",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 40,
      costUsd: "0.000000",
      latencyMs: 500,
      rawResponse: null,
      error: null,
    });
    await recordLlmCall(ctx, {
      agent: "extractor",
      promptVersion: "extractor.v1",
      model: "test-model",
      inputTokens: 200,
      outputTokens: 60,
      costUsd: "0.000000",
      latencyMs: 1500,
      rawResponse: null,
      error: "boom",
    });

    const res = await createApp().request("/api/metrics", { headers: HEADERS });
    const body = (await res.json()) as Metrics & { llm: { failedCalls: number; avgLatencyMs: number } };

    expect(body.llm.calls).toBe(2);
    expect(body.llm.failedCalls).toBe(1);
    expect(body.llm.inputTokens).toBe(300);
    expect(body.llm.outputTokens).toBe(100);
    expect(body.llm.avgLatencyMs).toBe(1000);
  });

  it("computes the needs-review rate over what was extracted", async () => {
    const app = appWith([CLEAN, FLAGGED]);

    await app.request(`/api/transcripts/${TRANSCRIPT_ID}/extract`, {
      method: "POST",
      headers: HEADERS,
    });

    const res = await app.request("/api/metrics", { headers: HEADERS });
    const body = (await res.json()) as Metrics;

    expect(body.requirements.total).toBe(2);
    expect(body.requirements.needsReview).toBe(1);
    expect(body.requirements.needsReviewRate).toBeCloseTo(0.5);
  });

  it("counts a connector refusal as approved, not as rejected", async () => {
    // A human said yes and the CRM said no. Folding that into the rejection
    // rate would blame the consultant for an integration failure.
    const app = appWith([CLEAN]);

    await app.request(`/api/transcripts/${TRANSCRIPT_ID}/extract`, {
      method: "POST",
      headers: HEADERS,
    });
    const listed = await app.request(`/api/transcripts/${TRANSCRIPT_ID}/requirements`, {
      headers: HEADERS,
    });
    const [requirement] = (await listed.json()) as { id: string }[];

    const proposed = await app.request(`/api/requirements/${requirement?.id}/propose`, {
      method: "POST",
      headers: HEADERS,
    });
    const { proposal } = (await proposed.json()) as { proposal: { id: string } };

    await app.request(`/api/proposals/${proposal.id}/approve`, {
      method: "POST",
      headers: HEADERS,
    });

    const res = await app.request("/api/metrics", { headers: HEADERS });
    const body = (await res.json()) as Metrics;

    expect(body.proposals.approvalRate).toBe(1);
    expect(body.proposals.rejectionRate).toBe(0);
  });

  it("never reports another tenant's numbers", async () => {
    await recordLlmCall(ctx, {
      agent: "extractor",
      promptVersion: "extractor.v1",
      model: "test-model",
      inputTokens: 999,
      outputTokens: 999,
      costUsd: "0.000000",
      latencyMs: 1,
      rawResponse: null,
      error: null,
    });

    const mine = await createApp().request("/api/metrics", { headers: HEADERS });
    const theirs = await createApp().request("/api/metrics", { headers: MERIDIAN_HEADERS });

    expect(((await mine.json()) as Metrics).llm.inputTokens).toBe(999);
    // Meridian did nothing, and cannot see that Northwind did.
    expect(((await theirs.json()) as Metrics).llm.inputTokens).toBe(0);
  });
});
