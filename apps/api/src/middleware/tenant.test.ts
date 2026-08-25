import { describe, expect, it } from "vitest";

import { createApp } from "../app";
import type { User } from "../db/repositories/users";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "11111111-0000-4000-8000-000000000001";

function appWith(findUserInTenant: (t: string, u: string) => Promise<User | undefined>) {
  return createApp({ tenant: { findUserInTenant } });
}

/**
 * These drive the middleware through the real app, with only the user lookup
 * faked - so the 401 path is exercised without a database, exactly as SPEC's
 * acceptance criterion describes it.
 */
describe("tenant middleware", () => {
  const found: User = {
    id: USER,
    tenantId: TENANT,
    name: "Ana Restrepo",
    email: "ana@northwind.test",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("rejects a request with no tenant headers with 401", async () => {
    const res = await appWith(async () => found).request("/api/projects");
    expect(res.status).toBe(401);
  });

  it("rejects a request missing either header with 401", async () => {
    const app = appWith(async () => found);

    expect(
      (await app.request("/api/projects", { headers: { "X-Tenant-Id": TENANT } })).status,
    ).toBe(401);
    expect(
      (await app.request("/api/projects", { headers: { "X-User-Id": USER } })).status,
    ).toBe(401);
  });

  it("rejects malformed ids with 401 rather than querying with them", async () => {
    let queried = false;
    const res = await appWith(async () => {
      queried = true;
      return found;
    }).request("/api/projects", {
      headers: { "X-Tenant-Id": "not-a-uuid", "X-User-Id": USER },
    });

    expect(res.status).toBe(401);
    expect(queried).toBe(false);
  });

  it("rejects a user who does not belong to the tenant with 403", async () => {
    const res = await appWith(async () => undefined).request("/api/projects", {
      headers: { "X-Tenant-Id": TENANT, "X-User-Id": USER },
    });

    expect(res.status).toBe(403);
  });

  it("passes the parsed context through on a valid pair", async () => {
    let seen: { tenantId: string; userId: string } | undefined;

    const res = await appWith(async (tenantId, userId) => {
      seen = { tenantId, userId };
      return found;
    }).request("/api/projects", {
      headers: { "X-Tenant-Id": TENANT, "X-User-Id": USER },
    });

    expect(res.status).toBe(200);
    expect(seen).toEqual({ tenantId: TENANT, userId: USER });
  });

  it("leaves /health public", async () => {
    const res = await appWith(async () => undefined).request("/health");
    expect(res.status).not.toBe(401);
  });
});
