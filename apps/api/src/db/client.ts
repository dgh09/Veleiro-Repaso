import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";

import { env } from "../env";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Keep this tight: the API is one dev process, and a long connect timeout
  // turns "Postgres is down" into "the page hangs" instead of an error state.
  max: 10,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool);

/**
 * Errors are values at boundaries (CLAUDE.md), so a failed ping is returned,
 * not thrown and not swallowed. The caller decides what to log and what to
 * expose - the reason must not leak to the client, but it must not vanish
 * either.
 */
export type DbPing = { ok: true } | { ok: false; error: Error };

/**
 * Drizzle wraps driver errors, so the outer `.message` is only ever
 * "Failed query: select 1" and the actual reason (auth failure, wrong port,
 * refused connection) sits in `.cause`. Flatten the chain so a log line is
 * enough to diagnose.
 */
function describe(cause: unknown): Error {
  if (!(cause instanceof Error)) return new Error(String(cause));

  const chain: string[] = [];
  let current: unknown = cause;
  while (current instanceof Error) {
    const code = "code" in current ? String(current.code) : undefined;
    chain.push(code ? `${current.message} (${code})` : current.message);
    current = current.cause;
  }

  const flattened = new Error(chain.join(" <- "));
  flattened.cause = cause;
  return flattened;
}

export async function pingDb(): Promise<DbPing> {
  try {
    await db.execute(sql`select 1`);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: describe(cause) };
  }
}
