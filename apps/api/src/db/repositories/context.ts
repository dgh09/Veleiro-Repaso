import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { TenantContext } from "@veleiro/shared";

/**
 * The tenant predicate is written here and nowhere else.
 *
 * CLAUDE.md rule 2: every read and write goes through a repository that takes a
 * TenantContext and injects the tenant_id filter. If a repository builds its
 * own `eq(table.tenantId, ...)` by hand, that rule has one more place to be got
 * wrong. Route handlers never reach Drizzle at all - `no-direct-db.test.ts`
 * fails the build if one tries.
 */
export function tenantScope(
  ctx: TenantContext,
  tenantColumn: PgColumn,
  ...extra: Array<SQL | undefined>
): SQL {
  const predicate = and(eq(tenantColumn, ctx.tenantId), ...extra);

  /* c8 ignore next 3 */
  if (predicate === undefined) {
    // `and()` only returns undefined when given nothing; the tenant equality
    // above is always present, so this is unreachable rather than handled.
    throw new Error("tenantScope produced an empty predicate");
  }

  return predicate;
}
