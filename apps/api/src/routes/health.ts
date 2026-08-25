import { Hono } from "hono";
import { HealthResponseSchema } from "@veleiro/shared";

import { pingDb as realPingDb, type DbPing } from "../db/client";

export interface HealthDeps {
  pingDb: () => Promise<DbPing>;
}

/**
 * Dependencies are injected rather than imported directly so the route can be
 * tested without a live Postgres. Same seam the agents will need in Phase 2.
 */
export function createHealthRoute(deps: HealthDeps = { pingDb: realPingDb }) {
  const route = new Hono();

  route.get("/health", async (c) => {
    const ping = await deps.pingDb();

    if (!ping.ok) {
      // The reason stays server-side; the client gets a status, not a stack.
      console.error("[health] database ping failed:", ping.error.message);
    }

    // Parsed on the way out too: the response contract lives in one place, and
    // a drift between this handler and the schema fails here, not in the UI.
    const body = HealthResponseSchema.parse({
      status: ping.ok ? "ok" : "error",
      db: ping.ok ? "ok" : "error",
    });

    return c.json(body, ping.ok ? 200 : 503);
  });

  return route;
}
