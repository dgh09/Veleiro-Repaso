import { and, asc, eq } from "drizzle-orm";
import type { TenantContext } from "@veleiro/shared";

import { db } from "../client";
import { users } from "../schema";
import { tenantScope } from "./context";

export type User = typeof users.$inferSelect;

export async function listUsers(ctx: TenantContext): Promise<User[]> {
  return db
    .select()
    .from(users)
    .where(tenantScope(ctx, users.tenantId))
    .orderBy(asc(users.name));
}

/**
 * The one function that does not take a TenantContext, because it is what
 * *produces* one.
 *
 * The middleware has to prove that X-User-Id belongs to X-Tenant-Id before a
 * context exists - otherwise anyone can pair their own tenant id with another
 * tenant's user id and the audit log's actor becomes forgeable, which would
 * quietly undermine rule 4. Both ids are still required to match on the same
 * row, so this is a check, not a way around the scoping.
 *
 * Nothing else may call this. It is not exported through a repository index.
 */
export async function findUserInTenant(
  tenantId: string,
  userId: string,
): Promise<User | undefined> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);

  return rows[0];
}
