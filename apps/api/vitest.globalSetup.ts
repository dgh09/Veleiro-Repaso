import pg from "pg";

import { runMigrations } from "./src/db/migrate";
import { TEST_DATABASE_NAME, TEST_DATABASE_URL } from "./test/database-url";

function adminUrl(testUrl: string): string {
  const url = new URL(testUrl);
  // Connect to the default database to issue CREATE DATABASE: you cannot
  // create a database from inside itself.
  url.pathname = "/veleiro";
  return url.toString();
}

/**
 * Provisions the throwaway test database, then migrates it with the same code
 * path the real one uses.
 *
 * Deliberately not a docker-entrypoint-initdb.d script: those run only when the
 * volume is empty, so adding one would silently do nothing until the next
 * `db:reset` and leave the suite failing for a reason nobody would guess.
 */
export async function setup(): Promise<void> {
  const admin = new pg.Pool({
    connectionString: adminUrl(TEST_DATABASE_URL),
    max: 1,
    connectionTimeoutMillis: 5_000,
  });

  try {
    const existing = await admin.query("select 1 from pg_database where datname = $1", [
      TEST_DATABASE_NAME,
    ]);
    if (existing.rowCount === 0) {
      // An identifier cannot be parameterised; this one is a constant.
      await admin.query(`create database ${TEST_DATABASE_NAME}`);
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Could not reach Postgres to prepare the ${TEST_DATABASE_NAME} database ` +
        `(${reason}).\n` +
        `These are integration tests against a real database. Run: npm run db:up`,
    );
  } finally {
    await admin.end();
  }

  await runMigrations(TEST_DATABASE_URL);
}
