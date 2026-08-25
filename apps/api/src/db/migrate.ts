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

/**
 * Takes an explicit connection string rather than reading env, so the Vitest
 * global setup can migrate the throwaway test database with the same code path
 * the real one uses.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  const { env } = await import("../env");
  await runMigrations(env.DATABASE_URL);
  console.log("[migrate] migrations applied");
}
