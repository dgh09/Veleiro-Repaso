import { sql } from "drizzle-orm";

import { db, describeDbError } from "../client";

/**
 * Not tenant-scoped, and deliberately so: /health is a system probe, not a read
 * of anyone's data. It lives here rather than beside the Drizzle client so that
 * every database access in the codebase sits under repositories/ and the rule
 * enforced by no-direct-db.test.ts needs no exception list.
 */
export type DbPing = { ok: true } | { ok: false; error: Error };

export async function pingDb(): Promise<DbPing> {
  try {
    await db.execute(sql`select 1`);
    return { ok: true };
  } catch (cause) {
    // Errors are values at boundaries (CLAUDE.md): returned, not thrown, and
    // not swallowed. The caller decides what to log and what to expose.
    return { ok: false, error: describeDbError(cause) };
  }
}
