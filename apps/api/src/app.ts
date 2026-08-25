import { Hono } from "hono";

import { createHealthRoute, type HealthDeps } from "./routes/health";

export interface AppDeps {
  health?: HealthDeps;
}

/**
 * Builds the app without listening, so tests can drive it via `app.request()`.
 * `index.ts` owns the socket.
 */
export function createApp(deps: AppDeps = {}) {
  const app = new Hono();

  app.route("/", createHealthRoute(deps.health));

  return app;
}

export type App = ReturnType<typeof createApp>;
