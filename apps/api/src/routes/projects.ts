import { Hono } from "hono";
import { CreateTranscriptSchema } from "@veleiro/shared";
import { z } from "zod";

import { listAuditLogForProject } from "../db/repositories/audit-log";
import { getProject, listProjects } from "../db/repositories/projects";
import { createTranscript, listTranscripts } from "../db/repositories/transcripts";
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

  route.post("/projects/:id/transcripts", async (c) => {
    const ctx = c.get("tenant");
    const projectId = c.req.param("id");

    // Resolving the project first is what proves it is this tenant's, before
    // anything is written against it.
    if (!(await getProject(ctx, projectId))) {
      return c.json({ error: "Project not found" }, 404);
    }

    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = CreateTranscriptSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    }

    const meetingDate = parsed.data.meetingDate;

    const created = await createTranscript(ctx, {
      projectId,
      title: parsed.data.title,
      content: parsed.data.content,
      meetingDate: meetingDate ? new Date(meetingDate) : null,
    });

    return c.json(created, 201);
  });

  route.get("/projects/:id/audit", async (c) => {
    const ctx = c.get("tenant");
    const projectId = c.req.param("id");

    if (!(await getProject(ctx, projectId))) {
      return c.json({ error: "Project not found" }, 404);
    }

    return c.json(await listAuditLogForProject(ctx, projectId));
  });

  return route;
}
