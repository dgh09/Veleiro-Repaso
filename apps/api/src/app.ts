import { Hono } from "hono";

import { createHealthRoute, type HealthDeps } from "./routes/health";
import { createProjectsRoute } from "./routes/projects";
import {
  createTranscriptsRoute,
  type TranscriptsRouteDeps,
} from "./routes/transcripts";
import {
  createRequirementsRoute,
  type RequirementsRouteDeps,
} from "./routes/requirements";
import {
  createProposalsRoute,
  type ProposalsRouteDeps,
} from "./routes/proposals";
import {
  tenantMiddleware,
  type TenantMiddlewareDeps,
  type TenantVariables,
} from "./middleware/tenant";

export interface AppDeps {
  health?: HealthDeps;
  tenant?: TenantMiddlewareDeps;
  transcripts?: TranscriptsRouteDeps;
  requirements?: RequirementsRouteDeps;
  proposals?: ProposalsRouteDeps;
}

/**
 * Builds the app without listening, so tests can drive it via `app.request()`.
 * `index.ts` owns the socket.
 */
export function createApp(deps: AppDeps = {}) {
  const app = new Hono<{ Variables: TenantVariables }>();

  // Public: /health has to answer even when nothing else can, and it is what
  // an operator hits before they have credentials of any kind.
  app.route("/", createHealthRoute(deps.health));

  // Everything under /api is tenant-scoped. Mounting the middleware on the
  // prefix rather than per-route means a new route cannot forget it.
  app.use("/api/*", tenantMiddleware(deps.tenant));
  app.route("/api", createProjectsRoute());
  app.route("/api", createTranscriptsRoute(deps.transcripts));
  app.route("/api", createRequirementsRoute(deps.requirements));
  app.route("/api", createProposalsRoute(deps.proposals));

  return app;
}

export type App = ReturnType<typeof createApp>;
