import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TenantContext } from "@veleiro/shared";

import { fakeLlmClient, says } from "../../test/fake-llm";
import { TEST_DATABASE_NAME } from "../../test/database-url";
import { runExtractor, type ExtractOptions } from "../agents/extractor/extractor";
import { createApp } from "../app";
import { db, pool } from "../db/client";
import { createRequirementsWithAudit } from "../db/repositories/requirements";
import { SEED, seed } from "../db/seed";

const NORTHWIND = SEED.northwind;
const MERIDIAN = SEED.meridian;

const ctx: TenantContext = {
  tenantId: NORTHWIND.id,
  userId: NORTHWIND.users[0].id,
};

const TRANSCRIPT_ID = NORTHWIND.projects[0].transcriptId;
const REAL_QUOTE = "We need the close date on the opportunity to be required";

function headers(tenantId: string, userId: string): Record<string, string> {
  return { "X-Tenant-Id": tenantId, "X-User-Id": userId };
}

const NORTHWIND_HEADERS = headers(NORTHWIND.id, NORTHWIND.users[0].id);

/**
 * The real agent driven by a canned model reply, so the route test exercises
 * the whole path - guardrails, persistence, audit - rather than a stub of it.
 */
function extractorReturning(requirements: unknown[]) {
  return (options: ExtractOptions) =>
    runExtractor({
      ...options,
      client: fakeLlmClient([says(JSON.stringify({ requirements }))]),
    });
}

const ONE_VALID_REQUIREMENT = [
  {
    title: "Require close date",
    description: "Close date must be mandatory",
    crmObject: "Opportunity",
    fieldName: "CloseDate",
    fieldType: "Date",
    rationale: "Forecast depends on it",
    sourceQuote: REAL_QUOTE,
    confidence: 0.9,
  },
];

beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL ?? "").pathname.replace("/", "");
  if (target !== TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing to run destructive tests against "${target}". ` +
        `Expected "${TEST_DATABASE_NAME}".`,
    );
  }

  await seed();
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table ${sql.identifier("requirements")}, ${sql.identifier("audit_log")} cascade`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("POST /api/transcripts/:id/extract", () => {
  it("extracts and returns 201 with the stored requirements", async () => {
    const app = createApp({
      transcripts: { runExtractor: extractorReturning(ONE_VALID_REQUIREMENT) },
    });

    const res = await app.request(`/api/transcripts/${TRANSCRIPT_ID}/extract`, {
      method: "POST",
      headers: NORTHWIND_HEADERS,
    });

    expect(res.status).toBe(201);

    const body = (await res.json()) as { requirements: { status: string; id: string }[] };
    expect(body.requirements).toHaveLength(1);
    expect(body.requirements[0]?.status).toBe("extracted");
  });

  it("returns 404 for a transcript that does not exist", async () => {
    const app = createApp({
      transcripts: { runExtractor: extractorReturning(ONE_VALID_REQUIREMENT) },
    });

    const res = await app.request(`/api/transcripts/${randomUUID()}/extract`, {
      method: "POST",
      headers: NORTHWIND_HEADERS,
    });

    expect(res.status).toBe(404);
  });

  it("returns 404, not 403, for another tenant's transcript", async () => {
    // Indistinguishable from missing on purpose: a 403 would confirm the row
    // exists, which is itself a cross-tenant disclosure.
    const app = createApp({
      transcripts: { runExtractor: extractorReturning(ONE_VALID_REQUIREMENT) },
    });

    const res = await app.request(
      `/api/transcripts/${MERIDIAN.projects[0].transcriptId}/extract`,
      { method: "POST", headers: NORTHWIND_HEADERS },
    );

    expect(res.status).toBe(404);
  });

  it("refuses to extract twice, rather than silently duplicating", async () => {
    await createRequirementsWithAudit(
      ctx,
      [
        {
          id: randomUUID(),
          projectId: NORTHWIND.projects[0].id,
          transcriptId: TRANSCRIPT_ID,
          title: "Already here",
          description: "d",
          crmObject: null,
          fieldName: null,
          fieldType: null,
          rationale: "r",
          sourceQuote: REAL_QUOTE,
          sourceQuoteStart: null,
          sourceQuoteEnd: null,
          confidence: 0.9,
          status: "extracted",
          reviewReason: null,
          relatedRequirementId: null,
        },
      ],
      {
        actorType: "agent",
        actorId: "extractor",
        action: "extract_requirements",
        entityType: "transcript",
        entityId: TRANSCRIPT_ID,
        before: null,
        after: null,
      },
    );

    const app = createApp({
      transcripts: { runExtractor: extractorReturning(ONE_VALID_REQUIREMENT) },
    });

    const res = await app.request(`/api/transcripts/${TRANSCRIPT_ID}/extract`, {
      method: "POST",
      headers: NORTHWIND_HEADERS,
    });

    expect(res.status).toBe(409);
  });

  it("returns 502 when the model fails, without inventing a result", async () => {
    const app = createApp({
      transcripts: {
        runExtractor: (options: ExtractOptions) =>
          runExtractor({
            ...options,
            client: fakeLlmClient([
              {
                ok: false,
                error: { kind: "transport", message: "socket hang up", latencyMs: 5 },
              },
            ]),
          }),
      },
    });

    const res = await app.request(`/api/transcripts/${TRANSCRIPT_ID}/extract`, {
      method: "POST",
      headers: NORTHWIND_HEADERS,
    });

    expect(res.status).toBe(502);
  });

  it("rejects a request with no tenant headers", async () => {
    const app = createApp({
      transcripts: { runExtractor: extractorReturning(ONE_VALID_REQUIREMENT) },
    });

    const res = await app.request(`/api/transcripts/${TRANSCRIPT_ID}/extract`, {
      method: "POST",
    });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/transcripts/:id/requirements", () => {
  it("lists what was extracted, scoped to the calling tenant", async () => {
    const app = createApp({
      transcripts: { runExtractor: extractorReturning(ONE_VALID_REQUIREMENT) },
    });

    await app.request(`/api/transcripts/${TRANSCRIPT_ID}/extract`, {
      method: "POST",
      headers: NORTHWIND_HEADERS,
    });

    const res = await app.request(`/api/transcripts/${TRANSCRIPT_ID}/requirements`, {
      headers: NORTHWIND_HEADERS,
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(1);
  });

  it("returns 404 for another tenant's transcript", async () => {
    const app = createApp();

    const res = await app.request(
      `/api/transcripts/${MERIDIAN.projects[0].transcriptId}/requirements`,
      { headers: NORTHWIND_HEADERS },
    );

    expect(res.status).toBe(404);
  });
});
