import { ProposalPayloadSchema, type TenantContext } from "@veleiro/shared";
import { z } from "zod";

import type { AuditEntry } from "../db/repositories/audit-log";
import {
  claimProposalForApproval,
  getProposal,
  rejectProposalWithAudit,
  settleProposalWithAudit,
  type Proposal,
} from "../db/repositories/proposals";
import type { ApplyResult, CrmConnector } from "../connectors/types";
import { createStubConnector } from "../connectors/stub";

/**
 * The human-triggered half of the system.
 *
 * Nothing in here is reachable from an agent. An agent writes a proposal and
 * stops; this module is the only thing that calls a connector, and it only ever
 * runs because a person hit approve. That separation is CLAUDE.md's central
 * rule, and keeping it in its own module is what makes it visible rather than
 * something you have to trace call sites to confirm.
 */

export type ApproveOutcome =
  | { kind: "not_found" }
  /** Already approved, applied, failed or rejected. The connector is not called again. */
  | { kind: "already_settled"; proposal: Proposal }
  | { kind: "settled"; proposal: Proposal; result: ApplyResult };

export interface ApproveOptions {
  ctx: TenantContext;
  proposalId: string;
  connector?: CrmConnector;
}

export async function approveProposal(options: ApproveOptions): Promise<ApproveOutcome> {
  const { ctx, proposalId } = options;
  const connector = options.connector ?? createStubConnector();

  // Atomic claim. If this returns nothing, someone or something already settled
  // this proposal, and applying again is exactly what must not happen.
  const claimed = await claimProposalForApproval(ctx, proposalId, ctx.userId);

  if (claimed === undefined) {
    const existing = await getProposal(ctx, proposalId);
    if (existing === undefined) return { kind: "not_found" };
    return { kind: "already_settled", proposal: existing };
  }

  /**
   * The payload is re-parsed on the way out of the database.
   *
   * It is jsonb, so Drizzle hands it back as `unknown`, and it originated as
   * model output. Trusting it here because it was validated when it was written
   * would mean the connector - the one component that touches a real system -
   * runs on unvalidated data (CLAUDE.md rule 5).
   */
  const parsed = ProposalPayloadSchema.safeParse(claimed.payload);

  const result: ApplyResult = parsed.success
    ? await connector.apply(parsed.data)
    : {
        ok: false,
        error: `Stored payload does not match any known change type: ${z.prettifyError(parsed.error)}`,
      };

  const status = result.ok ? "applied" : "failed";

  const audit: AuditEntry = {
    actorType: "user",
    actorId: ctx.userId,
    action: result.ok ? "apply_proposal" : "apply_proposal_failed",
    entityType: "proposal",
    entityId: proposalId,
    before: { status: "pending" },
    after: result.ok
      ? { status, externalId: result.externalId, details: result.details }
      : { status, error: result.error },
  };

  const settled = await settleProposalWithAudit(ctx, proposalId, status, audit);

  // A failed apply keeps the proposal, marked `failed`, with the reason in the
  // audit log. Losing it would mean losing the record that someone approved it.
  return { kind: "settled", proposal: settled ?? claimed, result };
}

export type RejectOutcome =
  | { kind: "not_found" }
  | { kind: "not_pending"; proposal: Proposal }
  | { kind: "rejected"; proposal: Proposal };

export interface RejectOptions {
  ctx: TenantContext;
  proposalId: string;
  /** Required and non-empty. Validated at the route boundary before reaching here. */
  rejectionReason: string;
}

export async function rejectProposal(options: RejectOptions): Promise<RejectOutcome> {
  const { ctx, proposalId, rejectionReason } = options;

  // Read first, only to learn which requirement this proposal belongs to so the
  // audit entries can name it. This is not a check-then-act race: the
  // compare-and-swap below is still what decides whether anything happens, and
  // a proposal's requirement_id never changes.
  const existing = await getProposal(ctx, proposalId);
  if (existing === undefined) return { kind: "not_found" };

  const audits: AuditEntry[] = [
    {
      actorType: "user",
      actorId: ctx.userId,
      action: "reject_proposal",
      entityType: "proposal",
      entityId: proposalId,
      before: { status: "pending" },
      // The stated reason is part of the audit record, not just a column. SPEC
      // requires rejections to capture why, and this is where a reader looks.
      after: { status: "rejected", rejectionReason },
    },
    {
      actorType: "user",
      actorId: ctx.userId,
      action: "discard_requirement",
      entityType: "requirement",
      entityId: existing.requirementId,
      before: { status: "proposed" },
      after: { status: "discarded", rejectionReason },
    },
  ];

  const rejected = await rejectProposalWithAudit(
    ctx,
    proposalId,
    ctx.userId,
    rejectionReason,
    audits,
  );

  if (rejected !== undefined) return { kind: "rejected", proposal: rejected };

  // The swap did not take. Re-read rather than reporting the status we saw
  // before, which may have moved on while we were building the audit entries.
  const current = await getProposal(ctx, proposalId);
  if (current === undefined) return { kind: "not_found" };
  return { kind: "not_pending", proposal: current };
}
