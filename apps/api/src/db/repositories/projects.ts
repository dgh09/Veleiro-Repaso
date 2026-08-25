import { asc, eq } from "drizzle-orm";
import type { TenantContext } from "@veleiro/shared";

import { db } from "../client";
import { projects } from "../schema";
import { tenantScope } from "./context";

export type Project = typeof projects.$inferSelect;

export async function listProjects(ctx: TenantContext): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(tenantScope(ctx, projects.tenantId))
    .orderBy(asc(projects.name));
}

/**
 * Returns undefined both when the project does not exist and when it belongs to
 * another tenant. The caller cannot tell the two apart, which is deliberate:
 * "not found" must not become an existence oracle for other tenants' ids.
 */
export async function getProject(
  ctx: TenantContext,
  id: string,
): Promise<Project | undefined> {
  const rows = await db
    .select()
    .from(projects)
    .where(tenantScope(ctx, projects.tenantId, eq(projects.id, id)))
    .limit(1);

  return rows[0];
}
