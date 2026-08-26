import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { env } from "../env";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Keep this tight: the API is one dev process, and a long connect timeout
  // turns "Postgres is down" into "the page hangs" instead of an error state.
  max: 10,
  connectionTimeoutMillis: 5_000,
  // TCP keepalives on idle connections. Docker Desktop's port proxy on Windows
  // drops quiet sockets under host load, which surfaces later as "Connection
  // terminated unexpectedly" on a connection the pool still believed was good.
  keepAlive: true,
});

/**
 * Without this, an error on an idle pooled client is an unhandled 'error' event
 * on the pool, and node exits the process. A socket dying while nobody is using
 * it should cost us that connection, not the server.
 *
 * Note what is deliberately absent: any retry of the failed query. Migrations
 * can be retried because Drizzle knows which ones already ran (see migrate.ts);
 * an arbitrary statement cannot, and silently re-running a write that may have
 * half-committed would be a worse bug than the dropped connection.
 */
pool.on("error", (cause) => {
  console.error(`[db] idle client error: ${describeDbError(cause).message}`);
});

export const db = drizzle(pool);

/**
 * Drizzle wraps driver errors, so the outer `.message` is only ever
 * "Failed query: ..." and the actual reason (auth failure, wrong port, refused
 * connection) sits in `.cause`. Flatten the chain so one log line is enough to
 * diagnose.
 */
export function describeDbError(cause: unknown): Error {
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
