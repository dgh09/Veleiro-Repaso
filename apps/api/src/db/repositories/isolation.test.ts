import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@veleiro/shared";

import { db, pool } from "../client";
import { SEED, seed } from "../seed";
import { TEST_DATABASE_NAME } from "../../../test/database-url";
import { getProject, listProjects } from "./projects";
import { getTranscript, getTranscriptWithProject, listTranscripts } from "./transcripts";
import { listUsers } from "./users";

const A: TenantContext = {
  tenantId: SEED.northwind.id,
  userId: SEED.northwind.users[0].id,
};
const B: TenantContext = {
  tenantId: SEED.meridian.id,
  userId: SEED.meridian.users[0].id,
};

const B_PROJECT = SEED.meridian.projects[0];
const B_TRANSCRIPT = SEED.meridian.projects[0].transcriptId;

beforeAll(async () => {
  // This suite truncates. If the worker ever loses vitest's env override it
  // would fall back to env.ts loading the root .env - and wipe the dev
  // database. Refuse rather than trust the configuration.
  const target = new URL(process.env.DATABASE_URL ?? "").pathname.replace("/", "");
  if (target !== TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing to run destructive tests against "${target}". ` +
        `Expected "${TEST_DATABASE_NAME}".`,
    );
  }

  await db.execute(
    sql`truncate table ${sql.identifier("tenants")} restart identity cascade`,
  );
  await seed();
});

afterAll(async () => {
  await pool.end();
});

describe("tenant isolation", () => {
  it("seeds two tenants, because one cannot demonstrate isolation", async () => {
    expect(await listProjects(A)).toHaveLength(2);
    expect(await listProjects(B)).toHaveLength(2);
  });

  // SPEC's three required cases: by ID, by list, by join.

  it("cannot read another tenant's row by id", async () => {
    expect(await getProject(A, B_PROJECT.id)).toBeUndefined();
    expect(await getTranscript(A, B_TRANSCRIPT)).toBeUndefined();

    // The same ids resolve for their real owner, so the assertions above are
    // about the tenant filter and not about the rows being absent.
    expect(await getProject(B, B_PROJECT.id)).toBeDefined();
    expect(await getTranscript(B, B_TRANSCRIPT)).toBeDefined();
  });

  it("cannot see another tenant's rows in a list", async () => {
    const projectsA = await listProjects(A);
    const idsA = projectsA.map((p) => p.id);

    expect(idsA).not.toContain(B_PROJECT.id);
    expect(projectsA.every((p) => p.tenantId === A.tenantId)).toBe(true);

    const usersA = await listUsers(A);
    expect(usersA.every((u) => u.tenantId === A.tenantId)).toBe(true);
    expect(usersA.map((u) => u.email)).not.toContain(SEED.meridian.users[0].email);
  });

  it("cannot reach another tenant's rows through a join", async () => {
    expect(await getTranscriptWithProject(A, B_TRANSCRIPT)).toBeUndefined();

    const joined = await getTranscriptWithProject(B, B_TRANSCRIPT);
    expect(joined?.clientName).toBe(B_PROJECT.clientName);
  });

  it("returns nothing when listing another tenant's project by id", async () => {
    // A knows B's project id but is not its tenant: the list must come back
    // empty rather than leaking B's transcripts.
    expect(await listTranscripts(A, B_PROJECT.id)).toEqual([]);
    expect(await listTranscripts(B, B_PROJECT.id)).toHaveLength(1);
  });

  it("is symmetric - B cannot read A either", async () => {
    const aProject = SEED.northwind.projects[0];
    expect(await getProject(B, aProject.id)).toBeUndefined();
    expect(await getTranscriptWithProject(B, aProject.transcriptId)).toBeUndefined();
  });
});
