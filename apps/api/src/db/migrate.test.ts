import pg from "pg";
import { afterAll, expect, it } from "vitest";

import { runMigrations } from "./migrate";
import { TEST_DATABASE_URL } from "../../test/database-url.ts";

/**
 * SPEC Phase 1 asks that migrations "run clean from empty, and roll back".
 * Drizzle Kit generates no down migrations and has no rollback command, so the
 * half that is actually worth protecting without a production database is that
 * the schema rebuilds from nothing. That is what this asserts.
 *
 * It uses its own database rather than veleiro_test: dropping the schema out
 * from under the other suites would make them order-dependent.
 */
const REBUILD_DB = "veleiro_rebuild_test";

function urlFor(database: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withAdmin<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const admin = new pg.Pool({
    connectionString: urlFor("veleiro"),
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

afterAll(async () => {
  await withAdmin(async (admin) => {
    await admin.query(`drop database if exists ${REBUILD_DB} with (force)`);
  });
});

it("rebuilds the whole schema from an empty database", async () => {
  await withAdmin(async (admin) => {
    await admin.query(`drop database if exists ${REBUILD_DB} with (force)`);
    await admin.query(`create database ${REBUILD_DB}`);
  });

  await runMigrations(urlFor(REBUILD_DB));

  const fresh = new pg.Pool({ connectionString: urlFor(REBUILD_DB), max: 1 });
  try {
    const tables = await fresh.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    // Drizzle keeps its migration journal in its own `drizzle` schema, so
    // public holds exactly the eight business tables.
    expect(tables.rows.map((r) => r.tablename)).toEqual([
      "audit_log",
      "llm_calls",
      "projects",
      "proposals",
      "requirements",
      "tenants",
      "transcripts",
      "users",
    ]);

    const enums = await fresh.query<{ typname: string }>(
      `select typname from pg_type where typtype = 'e' order by typname`,
    );
    expect(enums.rows.map((r) => r.typname)).toEqual([
      "actor_type",
      "change_type",
      "proposal_status",
      "requirement_status",
      "risk_level",
    ]);

    // Every business table carries the tenant discriminator. A new table that
    // forgets it fails here rather than in a leak six months from now.
    const withoutTenant = await fresh.query<{ tablename: string }>(
      `select t.tablename from pg_tables t
        where t.schemaname = 'public'
          and t.tablename <> 'tenants'
          and not exists (
            select 1 from information_schema.columns c
             where c.table_name = t.tablename and c.column_name = 'tenant_id'
          )`,
    );
    expect(withoutTenant.rows.map((r) => r.tablename)).toEqual([]);
  } finally {
    await fresh.end();
  }
}, 60_000);
