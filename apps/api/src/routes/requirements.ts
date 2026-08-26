import { Hono } from "hono";

import { runProposer } from "../agents/proposer/proposer";
import { describeAgentFailure } from "../agents/runtime/errors";
import { countProposalsForRequirement } from "../db/repositories/proposals";
import { getRequirement } from "../db/repositories/requirements";
import type { TenantVariables } from "../middleware/tenant";

export interface RequirementsRouteDeps {
  runProposer: typeof runProposer;
}

export function createRequirementsRoute(
  deps: RequirementsRouteDeps = { runProposer },
) {
  const route = new Hono<{ Variables: TenantVariables }>();

  route.post("/requirements/:id/propose", async (c) => {
    const ctx = c.get("tenant");
    const id = c.req.param("id");

    const requirement = await getRequirement(ctx, id);
    if (!requirement) return c.json({ error: "Requirement not found" }, 404);

    /**
     * SPEC: requirements with status needs_review are never proposed.
     *
     * This is the guardrail earning its keep. An item was flagged because its
     * evidence was fabricated, its confidence was low, or it contradicts
     * another - turning any of those into a change proposal would launder the
     * problem into something that looks reviewable and concrete.
     */
    if (requirement.status === "needs_review") {
      return c.json(
        {
          error:
            "This requirement needs human review and cannot be proposed. " +
            `Reason: ${requirement.reviewReason ?? "unknown"}`,
        },
        409,
      );
    }

    if (requirement.status === "discarded") {
      return c.json({ error: "This requirement was discarded" }, 409);
    }

    // Same reasoning as re-extraction: nothing makes a second run a no-op, so
    // it refuses rather than quietly creating a second proposal for one need.
    if ((await countProposalsForRequirement(ctx, id)) > 0) {
      return c.json(
        { error: "This requirement already has a proposal" },
        409,
      );
    }

    const result = await deps.runProposer({ ctx, requirement });

    if (!result.ok) {
      return c.json({ error: describeAgentFailure(result.error) }, 502);
    }

    return c.json({ proposal: result.value.proposal }, 201);
  });

  return route;
}
