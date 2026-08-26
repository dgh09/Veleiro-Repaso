import { desc, eq } from "drizzle-orm";
import type { TenantContext } from "@veleiro/shared";

import { db } from "../client";
import { projects, transcripts } from "../schema";
import { tenantScope } from "./context";

export type Transcript = typeof transcripts.$inferSelect;

export interface NewTranscript {
  projectId: string;
  title: string;
  content: string;
  meetingDate: Date | null;
}

/**
 * Tenant injected from the context, never taken from the caller. The project is
 * expected to have been resolved through `getProject` first, which is what
 * establishes it belongs to this tenant.
 */
export async function createTranscript(
  ctx: TenantContext,
  input: NewTranscript,
): Promise<Transcript> {
  const rows = await db
    .insert(transcripts)
    .values({ ...input, tenantId: ctx.tenantId })
    .returning();

  const created = rows[0];
  /* c8 ignore next */
  if (created === undefined) throw new Error("insert into transcripts returned no row");

  return created;
}

export interface TranscriptWithProject {
  transcript: Transcript;
  projectName: string;
  clientName: string;
}

export async function listTranscripts(
  ctx: TenantContext,
  projectId: string,
): Promise<Transcript[]> {
  return db
    .select()
    .from(transcripts)
    .where(tenantScope(ctx, transcripts.tenantId, eq(transcripts.projectId, projectId)))
    .orderBy(desc(transcripts.meetingDate), desc(transcripts.createdAt));
}

export async function getTranscript(
  ctx: TenantContext,
  id: string,
): Promise<Transcript | undefined> {
  const rows = await db
    .select()
    .from(transcripts)
    .where(tenantScope(ctx, transcripts.tenantId, eq(transcripts.id, id)))
    .limit(1);

  return rows[0];
}

/**
 * The join case. Both sides of the join are scoped: the transcript by the
 * predicate, and the project by carrying tenant_id into the ON clause. Joining
 * on project_id alone would be enough in a correct database, but it would make
 * isolation depend on referential integrity rather than on the filter - and a
 * join is exactly where a leak would hide.
 */
export async function getTranscriptWithProject(
  ctx: TenantContext,
  id: string,
): Promise<TranscriptWithProject | undefined> {
  const rows = await db
    .select({
      transcript: transcripts,
      projectName: projects.name,
      clientName: projects.clientName,
    })
    .from(transcripts)
    .innerJoin(
      projects,
      tenantScope(ctx, projects.tenantId, eq(projects.id, transcripts.projectId)),
    )
    .where(tenantScope(ctx, transcripts.tenantId, eq(transcripts.id, id)))
    .limit(1);

  return rows[0];
}
