import { createMiddleware } from "hono/factory";
import { TenantContextSchema, type TenantContext } from "@veleiro/shared";

import { findUserInTenant, type User } from "../db/repositories/users";

export interface TenantVariables {
  tenant: TenantContext;
}

export interface TenantMiddlewareDeps {
  findUserInTenant: (tenantId: string, userId: string) => Promise<User | undefined>;
}

/**
 * Stands in for authentication: tenant and user come from headers, as SPEC
 * requires. The stub is the identity, not the isolation - everything
 * downstream of this is real.
 *
 * 401 for a missing or malformed header pair. It is really a 400 (there is no
 * authentication to fail), but SPEC asks for 401 because this is where auth
 * would go, and the README says so.
 *
 * 403 when the ids are well-formed but the user does not belong to the tenant.
 * Without that check, any caller could pair their own tenant id with another
 * tenant's user id and write a forged actor into the audit log.
 */
export function tenantMiddleware(
  deps: TenantMiddlewareDeps = { findUserInTenant },
) {
  return createMiddleware<{ Variables: TenantVariables }>(async (c, next) => {
    const parsed = TenantContextSchema.safeParse({
      tenantId: c.req.header("X-Tenant-Id"),
      userId: c.req.header("X-User-Id"),
    });

    if (!parsed.success) {
      return c.json(
        { error: "X-Tenant-Id and X-User-Id headers are required and must be uuids" },
        401,
      );
    }

    const user = await deps.findUserInTenant(parsed.data.tenantId, parsed.data.userId);
    if (!user) {
      return c.json({ error: "User does not belong to this tenant" }, 403);
    }

    c.set("tenant", parsed.data);
    await next();
    return;
  });
}
