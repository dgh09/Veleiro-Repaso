import { Hono } from "hono";

import { getTenantMetrics } from "../db/repositories/metrics";
import type { TenantVariables } from "../middleware/tenant";

/**
 * Per tenant, and only ever the calling tenant's own numbers. There is no
 * "all tenants" view and no tenant id parameter: what a consulting firm spends
 * on models is not another firm's business, and an endpoint that could report
 * it would be a leak waiting for a bug in an authorisation check.
 */
export function createMetricsRoute() {
  const route = new Hono<{ Variables: TenantVariables }>();

  route.get("/metrics", async (c) => {
    return c.json(await getTenantMetrics(c.get("tenant")));
  });

  return route;
}
