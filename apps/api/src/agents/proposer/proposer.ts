import { randomUUID } from "node:crypto";

import { ProposalDraftSchema, type TenantContext } from "@veleiro/shared";

import type { AuditEntry } from "../../db/repositories/audit-log";
import {
  createProposalWithAudit,
  type Proposal,
} from "../../db/repositories/proposals";
import type { Requirement } from "../../db/repositories/requirements";
import { createAgentLlmClient } from "../../llm/factory";
import type { LlmClient, LlmMessage } from "../../llm/types";
import type { AgentResult } from "../runtime/errors";
import { completeStructured } from "../runtime/structured";
import { PROPOSER_PROMPT } from "../prompts/proposer.v1";
import { assessRisk } from "./risk";

/**
 * The Proposer: one requirement in, one machine-applicable proposal out.
 *
 * What it does not do is apply anything. It writes a row to `proposals` with
 * status `pending` and stops. The connector is not reachable from here - not by
 * convention, but because this module has no reference to it. That is
 * CLAUDE.md's first rule made structural rather than promised.
 */

export const PROPOSER_AGENT = "proposer";

export interface ProposeOptions {
  ctx: TenantContext;
  requirement: Requirement;
  /** Injectable so tests drive a canned model response instead of the network. */
  client?: LlmClient;
}

export interface ProposeOutcome {
  proposal: Proposal;
}

function requirementBrief(requirement: Requirement): string {
  return [
    "Produce one configuration change for this requirement.",
    "",
    `Title: ${requirement.title}`,
    `Description: ${requirement.description}`,
    `Rationale: ${requirement.rationale}`,
    `CRM object: ${requirement.crmObject ?? "(not stated)"}`,
    `Field name: ${requirement.fieldName ?? "(not stated)"}`,
    `Field type: ${requirement.fieldType ?? "(not stated)"}`,
    "",
    "The client's own words, quoted from the discovery call:",
    requirement.sourceQuote,
  ].join("\n");
}

export async function runProposer(
  options: ProposeOptions,
): Promise<AgentResult<ProposeOutcome>> {
  const { ctx, requirement } = options;

  const client =
    options.client ??
    createAgentLlmClient({
      ctx,
      agent: PROPOSER_AGENT,
      promptVersion: PROPOSER_PROMPT.version,
    });

  const messages: LlmMessage[] = [
    { role: "system", content: PROPOSER_PROMPT.system },
    { role: "user", content: requirementBrief(requirement) },
  ];

  const result = await completeStructured({
    client,
    schema: ProposalDraftSchema,
    messages,
    request: { maxTokens: 2_000 },
  });

  if (!result.ok) return result;

  const { payload } = result.value;

  // Assigned here, from the payload the model produced - never taken from the
  // model itself. See ./risk.ts for why that distinction is load-bearing.
  const riskLevel = assessRisk(payload);

  const audit: AuditEntry = {
    actorType: "agent",
    actorId: PROPOSER_AGENT,
    action: "propose_change",
    entityType: "requirement",
    entityId: requirement.id,
    before: { status: requirement.status },
    after: {
      status: "proposed",
      promptVersion: PROPOSER_PROMPT.version,
      changeType: payload.changeType,
      riskLevel,
    },
  };

  const proposal = await createProposalWithAudit(
    ctx,
    {
      id: randomUUID(),
      requirementId: requirement.id,
      changeType: payload.changeType,
      payload,
      riskLevel,
    },
    audit,
  );

  return { ok: true, value: { proposal } };
}
