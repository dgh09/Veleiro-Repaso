import { asc, desc, eq, inArray, or } from "drizzle-orm";
import type { ActorType, TenantContext } from "@veleiro/shared";

import { db } from "../client";
import { auditLog, proposals, requirements, transcripts } from "../schema";
import { tenantScope } from "./context";

export type AuditRow = typeof auditLog.$inferSelect;

/**
 * CLAUDE.md rule 4: every state change is audited, with the actor, the action,
 * the entity and the before/after. Agents and humans both write here, which is
 * what lets Phase 5 show the two kinds of action distinctly.
 */
export interface AuditEntry {
  actorType: ActorType;
  /**
   * A user uuid when actorType is "user"; the agent identifier when it is
   * "agent". The column is text rather than a users FK for exactly that reason.
   */
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
}

/**
 * Builds the insert values, tenant injected from the context.
 *
 * Exported as values rather than as a function that writes, because the callers
 * that matter run inside a transaction alongside the change they are auditing -
 * an audit row that can commit while the change rolls back would be worse than
 * none.
 */
export function auditValues(
  ctx: TenantContext,
  entry: AuditEntry,
): typeof auditLog.$inferInsert {
  return {
    tenantId: ctx.tenantId,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  };
}

export async function listAuditLog(ctx: TenantContext, limit = 100): Promise<AuditRow[]> {
  return db
    .select()
    .from(auditLog)
    .where(tenantScope(ctx, auditLog.tenantId))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

/**
 * The audit trail for one project, oldest first.
 *
 * `audit_log` has no project_id - it references entities, not projects - so the
 * project's rows are reached through the three entity types that belong to one:
 * its transcripts, its requirements, and the proposals made against those
 * requirements. Every subquery is tenant-scoped in its own right, so a
 * hand-crafted entity id from another tenant matches nothing.
 *
 * Chronological rather than newest-first, because this is read as a story: the
 * agent extracted, the agent proposed, then a person decided.
 */
export async function listAuditLogForProject(
  ctx: TenantContext,
  projectId: string,
  limit = 200,
): Promise<AuditRow[]> {
  const transcriptIds = db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(
      tenantScope(ctx, transcripts.tenantId, eq(transcripts.projectId, projectId)),
    );

  const requirementIds = db
    .select({ id: requirements.id })
    .from(requirements)
    .where(
      tenantScope(ctx, requirements.tenantId, eq(requirements.projectId, projectId)),
    );

  const proposalIds = db
    .select({ id: proposals.id })
    .from(proposals)
    .innerJoin(
      requirements,
      tenantScope(
        ctx,
        requirements.tenantId,
        eq(requirements.id, proposals.requirementId),
        eq(requirements.projectId, projectId),
      ),
    )
    .where(tenantScope(ctx, proposals.tenantId));

  return db
    .select()
    .from(auditLog)
    .where(
      tenantScope(
        ctx,
        auditLog.tenantId,
        or(
          inArray(auditLog.entityId, transcriptIds),
          inArray(auditLog.entityId, requirementIds),
          inArray(auditLog.entityId, proposalIds),
        ),
      ),
    )
    .orderBy(asc(auditLog.createdAt))
    .limit(limit);
}
