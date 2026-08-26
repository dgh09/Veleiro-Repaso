import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TenantContext } from "@veleiro/shared";

import { fakeLlmClient, says } from "../../test/fake-llm";
import { TEST_DATABASE_NAME } from "../../test/database-url";
import { runExtractor, type ExtractOptions } from "../agents/extractor/extractor";
import { createApp } from "../app";
import { db, pool } from "../db/client";
import { SEED, seed } from "../db/seed";

const NORTHWIND = SEED.northwind;
const MERIDIAN = SEED.meridian;

const HEADERS = {
  "X-Tenant-Id": NORTHWIND.id,
  "X-User-Id": NORTHWIND.users[0].id,
};
const JSON_HEADERS = { ...HEADERS, "Content-Type": "application/json" };

const PROJECT_ID = NORTHWIND.projects[0].id;
const TRANSCRIPT_ID = NORTHWIND.projects[0].transcriptId;
const REAL_QUOTE = "We need the close date on the opportunity to be required";

const ctx: TenantContext = {
  tenantId: NORTHWIND.id,
  userId: NORTHWIND.users[0].id,
};

function appWithExtractor() {
  return createApp({
    transcripts: {
      runExtractor: (o: ExtractOptions) =>
        runExtractor({
          ...o,
          client: fakeLlmClient([
            says(
              JSON.stringify({
                requirements: [
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
                ],
              }),
            ),
          ]),
        }),
    },
  });
}

beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL ?? "").pathname.replace("/", "");
  if (target !== TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing to run destructive tests against "${target}". Expected "${TEST_DATABASE_NAME}".`,
    );
  }
  await seed();
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table ${sql.identifier("requirements")}, ${sql.identifier("proposals")}, ${sql.identifier("audit_log")} cascade`,
  );
  // The seed's own transcripts are restored by re-seeding; anything a test
  // pasted is not, which keeps the pasted-transcript cases independent.
  await db.execute(
    sql`delete from ${sql.identifier("transcripts")} where title like 'Pasted%'`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("POST /api/projects/:id/transcripts", () => {
  it("accepts a pasted transcript and returns it", async () => {
    const app = createApp();

    const res = await app.request(`/api/projects/${PROJECT_ID}/transcripts`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: "Pasted discovery call",
        content: "Consultant: hello.\nClient: we need a field.",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; projectId: string; tenantId: string };
    expect(body.projectId).toBe(PROJECT_ID);
    // The tenant comes from the header, never from the request body.
    expect(body.tenantId).toBe(NORTHWIND.id);
  });

  it("refuses an empty transcript", async () => {
    const app = createApp();

    const res = await app.request(`/api/projects/${PROJECT_ID}/transcripts`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Pasted nothing", content: "   " }),
    });

    expect(res.status).toBe(400);
  });

  it("refuses a transcript with no title", async () => {
    const app = createApp();

    const res = await app.request(`/api/projects/${PROJECT_ID}/transcripts`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "Consultant: hello." }),
    });

    expect(res.status).toBe(400);
  });

  it("will not write into another tenant's project", async () => {
    const app = createApp();

    const res = await app.request(
      `/api/projects/${MERIDIAN.projects[0].id}/transcripts`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: "Pasted intrusion", content: "hello" }),
      },
    );

    expect(res.status).toBe(404);
  });
});

describe("GET /api/transcripts/:id", () => {
  it("returns the full content, which the UI needs to highlight a quote", async () => {
    const app = createApp();

    const res = await app.request(`/api/transcripts/${TRANSCRIPT_ID}`, { headers: HEADERS });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain("close date");
  });

  it("returns 404 for another tenant's transcript", async () => {
    const app = createApp();

    const res = await app.request(
      `/api/transcripts/${MERIDIAN.projects[0].transcriptId}`,
      { headers: HEADERS },
    );

    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects/:id/audit", () => {
  it("returns the project's trail in chronological order", async () => {
    const app = appWithExtractor();

    await app.request(`/api/transcripts/${TRANSCRIPT_ID}/extract`, {
      method: "POST",
      headers: HEADERS,
    });

    const res = await app.request(`/api/projects/${PROJECT_ID}/audit`, { headers: HEADERS });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string; createdAt: string }[];
    expect(body.map((row) => row.action)).toContain("extract_requirements");

    const times = body.map((row) => new Date(row.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("does not leak another project's activity", async () => {
    const app = appWithExtractor();

    // Activity happens on project 0's transcript.
    await app.request(`/api/transcripts/${TRANSCRIPT_ID}/extract`, {
      method: "POST",
      headers: HEADERS,
    });

    // Project 1 of the same tenant must not show it. audit_log has no
    // project_id, so this is the query's join doing the work.
    const res = await app.request(
      `/api/projects/${NORTHWIND.projects[1].id}/audit`,
      { headers: HEADERS },
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toEqual([]);
  });

  it("returns 404 for another tenant's project", async () => {
    const app = createApp();

    const res = await app.request(`/api/projects/${MERIDIAN.projects[0].id}/audit`, {
      headers: HEADERS,
    });

    expect(res.status).toBe(404);
  });

  it("returns 404 for a project that does not exist", async () => {
    const app = createApp();

    const res = await app.request(`/api/projects/${randomUUID()}/audit`, {
      headers: HEADERS,
    });

    expect(res.status).toBe(404);
  });
});

describe("the seeded context these tests rely on", () => {
  it("still has two projects for Northwind", async () => {
    const app = createApp();
    const res = await app.request("/api/projects", { headers: HEADERS });

    expect((await res.json()) as unknown[]).toHaveLength(2);
    expect(ctx.tenantId).toBe(NORTHWIND.id);
  });
});
