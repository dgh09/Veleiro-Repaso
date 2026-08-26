import { fileURLToPath } from "node:url";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const MIGRATIONS_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
);

const MAX_ATTEMPTS = 3;
const BASE_RETRY_MS = 1_000;

/**
 * Errors where the socket died rather than the database objecting to anything.
 *
 * Observed on this project as `Connection terminated unexpectedly` partway
 * through a migration run, with no corresponding FATAL, PANIC or restart in the
 * PostgreSQL log - the server never dropped anything, the connection did. On
 * Windows that is Docker Desktop's port proxy giving up under host I/O
 * pressure. A syntax error or a constraint violation is not this, and must not
 * be retried.
 */
export function isTransientConnectionError(cause: unknown): boolean {
  const transientCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "ENOTFOUND",
    "EHOSTUNREACH",
  ]);

  const transientMessages = [
    "connection terminated",
    "timeout exceeded when trying to connect",
    "server closed the connection unexpectedly",
    "connection reset by peer",
  ];

  let current: unknown = cause;

  // Drizzle wraps driver errors, so the reason is usually further down the chain.
  while (current instanceof Error) {
    const code = "code" in current ? String(current.code) : undefined;
    if (code !== undefined && transientCodes.has(code)) return true;

    const message = current.message.toLowerCase();
    if (transientMessages.some((needle) => message.includes(needle))) return true;

    current = current.cause;
  }

  return false;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Takes an explicit connection string rather than reading env, so the Vitest
 * global setup can migrate the throwaway test database with the same code path
 * the real one uses.
 *
 * Retries only a dropped connection, and only here. Migrations are safe to
 * retry because Drizzle records which ones have been applied and skips them, so
 * a second run finishes the job rather than repeating it. That property is what
 * makes the retry correct - it is deliberately NOT extended to ordinary queries
 * in client.ts, where re-running a half-completed write would be a good deal
 * worse than the failure it was papering over.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const pool = new pg.Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 5_000,
    });

    try {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
      return;
    } catch (cause) {
      if (attempt === MAX_ATTEMPTS || !isTransientConnectionError(cause)) throw cause;

      console.warn(
        `[migrate] connection dropped on attempt ${attempt}/${MAX_ATTEMPTS}, retrying`,
      );
      await sleep(BASE_RETRY_MS * attempt);
    } finally {
      // The pool may already be broken; failing to close it is not the problem
      // worth reporting when we are on our way out with the real error.
      await pool.end().catch(() => undefined);
    }
  }
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  const { env } = await import("../env");
  await runMigrations(env.DATABASE_URL);
  console.log("[migrate] migrations applied");
}
