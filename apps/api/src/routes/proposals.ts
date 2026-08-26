import { Hono } from "hono";
import { ProposalStatusSchema, RejectProposalSchema } from "@veleiro/shared";
import { z } from "zod";

import { approveProposal, rejectProposal } from "../approvals/service";
import { listProposals } from "../db/repositories/proposals";
import type { TenantVariables } from "../middleware/tenant";

export interface ProposalsRouteDeps {
  approveProposal: typeof approveProposal;
  rejectProposal: typeof rejectProposal;
}

export function createProposalsRoute(
  deps: ProposalsRouteDeps = { approveProposal, rejectProposal },
) {
  const route = new Hono<{ Variables: TenantVariables }>();

  route.get("/proposals", async (c) => {
    const raw = c.req.query("status");

    if (raw === undefined) {
      return c.json(await listProposals(c.get("tenant")));
    }

    const status = ProposalStatusSchema.safeParse(raw);
    if (!status.success) {
      return c.json({ error: `Unknown status "${raw}"` }, 400);
    }

    return c.json(await listProposals(c.get("tenant"), status.data));
  });

  route.post("/proposals/:id/approve", async (c) => {
    const outcome = await deps.approveProposal({
      ctx: c.get("tenant"),
      proposalId: c.req.param("id"),
    });

    switch (outcome.kind) {
      case "not_found":
        return c.json({ error: "Proposal not found" }, 404);

      /**
       * Approving twice is not an error, it is a no-op. SPEC asks for the
       * original result rather than a second apply, so this returns 200 with
       * the proposal as it already stands and says plainly that nothing
       * happened this time.
       */
      case "already_settled":
        return c.json({ proposal: outcome.proposal, applied: false, alreadySettled: true });

      case "settled":
        /**
         * 200 even when the connector refused. The request did what it
         * promised: it recorded the approval and attempted the change. Whether
         * the CRM accepted it is in the body, and the proposal survives as
         * `failed` either way.
         */
        return c.json({
          proposal: outcome.proposal,
          applied: outcome.result.ok,
          alreadySettled: false,
          ...(outcome.result.ok
            ? { externalId: outcome.result.externalId }
            : { error: outcome.result.error }),
        });
    }
  });

  route.post("/proposals/:id/reject", async (c) => {
    // A rejection with no stated reason is not a rejection anyone can learn
    // from. SPEC requires 400, and the UI must make it impossible too.
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = RejectProposalSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    }

    const outcome = await deps.rejectProposal({
      ctx: c.get("tenant"),
      proposalId: c.req.param("id"),
      rejectionReason: parsed.data.rejectionReason,
    });

    switch (outcome.kind) {
      case "not_found":
        return c.json({ error: "Proposal not found" }, 404);
      case "not_pending":
        return c.json(
          { error: `Proposal is already ${outcome.proposal.status}` },
          409,
        );
      case "rejected":
        return c.json({ proposal: outcome.proposal });
    }
  });

  return route;
}
