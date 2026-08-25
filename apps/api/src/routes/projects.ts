import { Hono } from "hono";

import { getProject, listProjects } from "../db/repositories/projects";
import { listTranscripts } from "../db/repositories/transcripts";
import type { TenantVariables } from "../middleware/tenant";

/**
 * Note what this file does not import: the Drizzle client, or drizzle-orm.
 * Route handlers reach the database only through repositories, which is what
 * makes the tenant filter unavoidable. `no-direct-db.test.ts` enforces it.
 */
export function createProjectsRoute() {
  const route = new Hono<{ Variables: TenantVariables }>();

  route.get("/projects", async (c) => {
    return c.json(await listProjects(c.get("tenant")));
  });

  route.get("/projects/:id", async (c) => {
    const project = await getProject(c.get("tenant"), c.req.param("id"));

    // Another tenant's project is indistinguishable from a missing one.
    if (!project) return c.json({ error: "Project not found" }, 404);

    return c.json(project);
  });

  route.get("/projects/:id/transcripts", async (c) => {
    const ctx = c.get("tenant");
    const projectId = c.req.param("id");

    if (!(await getProject(ctx, projectId))) {
      return c.json({ error: "Project not found" }, 404);
    }

    return c.json(await listTranscripts(ctx, projectId));
  });

  return route;
}
