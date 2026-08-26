import { asc, eq, sql } from "drizzle-orm";
import type { RequirementStatus, TenantContext } from "@veleiro/shared";

import { db } from "../client";
import { auditLog, requirements } from "../schema";
import { auditValues, type AuditEntry } from "./audit-log";
import { tenantScope } from "./context";

export type Requirement = typeof requirements.$inferSelect;

/**
 * What the Extractor hands over for persistence.
 *
 * `id` is supplied by the caller rather than defaulted by the database, because
 * contradictory requirements point at each other through
 * `related_requirement_id` and both rows are written in the same statement.
 * Knowing the ids up front is what makes that a single insert instead of an
 * insert followed by a repair pass.
 *
 * There is no `tenantId` here on purpose: the repository injects it from the
 * context, so a caller cannot write a row into someone else's tenant even by
 * mistake.
 */
export interface RequirementDraft {
  id: string;
  projectId: string;
  transcriptId: string;
  title: string;
  description: string;
  crmObject: string | null;
  fieldName: string | null;
  fieldType: string | null;
  rationale: string;
  sourceQuote: string;
  sourceQuoteStart: number | null;
  sourceQuoteEnd: number | null;
  confidence: number;
  status: RequirementStatus;
  reviewReason: string | null;
  relatedRequirementId: string | null;
}

/**
 * Writes an extraction and its audit row atomically.
 *
 * Rule 4 says every state change is audited. If the audit insert fails, the
 * requirements must not survive it - otherwise the system holds rows nobody can
 * account for, which is precisely the situation the audit log exists to
 * prevent. A transaction is the only honest way to promise that.
 *
 * Mutual `related_requirement_id` references resolve because PostgreSQL checks
 * foreign keys at the end of the statement, so both sides of a contradiction
 * are visible to each other by the time the constraint is evaluated.
 */
export async function createRequirementsWithAudit(
  ctx: TenantContext,
  drafts: readonly RequirementDraft[],
  audit: AuditEntry,
): Promise<Requirement[]> {
  return db.transaction(async (tx) => {
    const inserted =
      drafts.length === 0
        ? []
        : await tx
            .insert(requirements)
            .values(drafts.map((draft) => ({ ...draft, tenantId: ctx.tenantId })))
            .returning();

    await tx.insert(auditLog).values(auditValues(ctx, audit));

    return inserted;
  });
}

export async function listRequirementsByTranscript(
  ctx: TenantContext,
  transcriptId: string,
): Promise<Requirement[]> {
  return db
    .select()
    .from(requirements)
    .where(
      tenantScope(ctx, requirements.tenantId, eq(requirements.transcriptId, transcriptId)),
    )
    .orderBy(asc(requirements.createdAt));
}

export async function countRequirementsByTranscript(
  ctx: TenantContext,
  transcriptId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(requirements)
    .where(
      tenantScope(ctx, requirements.tenantId, eq(requirements.transcriptId, transcriptId)),
    );

  return rows[0]?.count ?? 0;
}

export async function getRequirement(
  ctx: TenantContext,
  id: string,
): Promise<Requirement | undefined> {
  const rows = await db
    .select()
    .from(requirements)
    .where(tenantScope(ctx, requirements.tenantId, eq(requirements.id, id)))
    .limit(1);

  return rows[0];
}
