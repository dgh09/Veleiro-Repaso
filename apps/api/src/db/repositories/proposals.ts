import { desc, eq, sql } from "drizzle-orm";
import type {
  ChangeType,
  ProposalStatus,
  RiskLevel,
  TenantContext,
} from "@veleiro/shared";

import { db } from "../client";
import { auditLog, proposals, requirements } from "../schema";
import { auditValues, type AuditEntry } from "./audit-log";
import { tenantScope } from "./context";

export type Proposal = typeof proposals.$inferSelect;

export interface NewProposal {
  id: string;
  requirementId: string;
  changeType: ChangeType;
  payload: unknown;
  riskLevel: RiskLevel;
}

/**
 * Writes the proposal, moves its requirement to `proposed`, and audits - all or
 * nothing. A proposal whose requirement still says `extracted` would be
 * proposable a second time, which is the duplication this is preventing.
 */
export async function createProposalWithAudit(
  ctx: TenantContext,
  draft: NewProposal,
  audit: AuditEntry,
): Promise<Proposal> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(proposals)
      .values({ ...draft, tenantId: ctx.tenantId })
      .returning();

    const created = rows[0];
    /* c8 ignore next */
    if (created === undefined) throw new Error("insert into proposals returned no row");

    await tx
      .update(requirements)
      .set({ status: "proposed" })
      .where(
        tenantScope(ctx, requirements.tenantId, eq(requirements.id, draft.requirementId)),
      );

    await tx.insert(auditLog).values(auditValues(ctx, audit));

    return created;
  });
}

/**
 * Proposals for one tenant, optionally narrowed to a status and a project.
 *
 * The project filter joins through `requirements`, because a proposal has no
 * project of its own - it belongs to a requirement, and the requirement belongs
 * to a project. Both sides of the join carry the tenant predicate, so the join
 * cannot become a way around it.
 */
export async function listProposals(
  ctx: TenantContext,
  status?: ProposalStatus,
  projectId?: string,
): Promise<Proposal[]> {
  const statusFilter = status === undefined ? undefined : eq(proposals.status, status);

  if (projectId === undefined) {
    return db
      .select()
      .from(proposals)
      .where(tenantScope(ctx, proposals.tenantId, statusFilter))
      .orderBy(desc(proposals.createdAt));
  }

  const rows = await db
    .select({ proposal: proposals })
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
    .where(tenantScope(ctx, proposals.tenantId, statusFilter))
    .orderBy(desc(proposals.createdAt));

  return rows.map((row) => row.proposal);
}

export async function getProposal(
  ctx: TenantContext,
  id: string,
): Promise<Proposal | undefined> {
  const rows = await db
    .select()
    .from(proposals)
    .where(tenantScope(ctx, proposals.tenantId, eq(proposals.id, id)))
    .limit(1);

  return rows[0];
}

export async function countProposalsForRequirement(
  ctx: TenantContext,
  requirementId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(proposals)
    .where(
      tenantScope(ctx, proposals.tenantId, eq(proposals.requirementId, requirementId)),
    );

  return rows[0]?.count ?? 0;
}

/**
 * Claims a pending proposal for approval, atomically.
 *
 * This is what makes approving twice apply once. The status predicate is inside
 * the UPDATE, so the database decides the winner: two concurrent approvals both
 * issue the same statement and exactly one comes back with a row. Checking the
 * status first and then updating would leave a window between the two where
 * both callers believe they won, and the connector would run twice.
 *
 * Returns undefined when the proposal was not pending - already approved,
 * already applied, already rejected, or not this tenant's.
 */
export async function claimProposalForApproval(
  ctx: TenantContext,
  id: string,
  userId: string,
): Promise<Proposal | undefined> {
  const rows = await db
    .update(proposals)
    .set({ status: "approved", reviewedBy: userId, reviewedAt: new Date() })
    .where(
      tenantScope(
        ctx,
        proposals.tenantId,
        eq(proposals.id, id),
        eq(proposals.status, "pending"),
      ),
    )
    .returning();

  return rows[0];
}

/**
 * Records what the connector did. Called only after a successful claim, so the
 * proposal is known to be this caller's to settle.
 */
export async function settleProposalWithAudit(
  ctx: TenantContext,
  id: string,
  status: Extract<ProposalStatus, "applied" | "failed">,
  audit: AuditEntry,
): Promise<Proposal | undefined> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(proposals)
      .set({ status })
      .where(tenantScope(ctx, proposals.tenantId, eq(proposals.id, id)))
      .returning();

    await tx.insert(auditLog).values(auditValues(ctx, audit));

    return rows[0];
  });
}

/**
 * Rejects a pending proposal, atomically, with the human's stated reason, and
 * discards the requirement behind it.
 *
 * Same compare-and-swap as the approval claim: a proposal that has already been
 * applied cannot be retroactively rejected. Nothing is written - not even an
 * audit row - when the swap does not take, because nothing happened.
 *
 * The requirement moves to `discarded` rather than staying at `proposed`. SPEC
 * defines that status and never says what triggers it; this is the only
 * plausible trigger, and without it a rejected requirement sits in `proposed`
 * forever, unable to be proposed again. The human's reason survives on the
 * proposal and in the audit log, so discarding loses no information.
 *
 * Two entities change, so two audit rows are written (rule 4). Auditing only
 * the proposal would leave the requirement's transition invisible to anyone
 * querying the log by requirement id.
 */
export async function rejectProposalWithAudit(
  ctx: TenantContext,
  id: string,
  userId: string,
  rejectionReason: string,
  audits: readonly AuditEntry[],
): Promise<Proposal | undefined> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(proposals)
      .set({
        status: "rejected",
        reviewedBy: userId,
        reviewedAt: new Date(),
        rejectionReason,
      })
      .where(
        tenantScope(
          ctx,
          proposals.tenantId,
          eq(proposals.id, id),
          eq(proposals.status, "pending"),
        ),
      )
      .returning();

    const rejected = rows[0];
    if (rejected === undefined) return undefined;

    await tx
      .update(requirements)
      .set({ status: "discarded" })
      .where(
        tenantScope(
          ctx,
          requirements.tenantId,
          eq(requirements.id, rejected.requirementId),
        ),
      );

    if (audits.length > 0) {
      await tx.insert(auditLog).values(audits.map((entry) => auditValues(ctx, entry)));
    }

    return rejected;
  });
}
