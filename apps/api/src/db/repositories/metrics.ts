import { sql } from "drizzle-orm";
import type { TenantContext } from "@veleiro/shared";

import { db } from "../client";
import { llmCalls, proposals, requirements } from "../schema";
import { tenantScope } from "./context";

/**
 * What this tenant's agents have cost and what its humans have decided.
 *
 * Aggregated in the database rather than by loading rows and summing in JS:
 * these tables grow with every call and every extraction, and a metrics
 * endpoint that gets slower the longer the system runs is a metrics endpoint
 * nobody opens.
 *
 * Tenant-scoped like everything else here. There is deliberately no
 * cross-tenant view - a consulting firm's spend is not another firm's business.
 */

export interface LlmUsageMetrics {
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Decimal string, not a float. This is money. */
  costUsd: string;
  avgLatencyMs: number;
}

export interface RequirementMetrics {
  total: number;
  needsReview: number;
  /** Share of extractions a human has to look at. */
  needsReviewRate: number;
}

export interface ProposalMetrics {
  total: number;
  pending: number;
  applied: number;
  failed: number;
  rejected: number;
  /** Of the proposals a human has decided, the share they approved. */
  approvalRate: number;
  rejectionRate: number;
}

export interface TenantMetrics {
  llm: LlmUsageMetrics;
  requirements: RequirementMetrics;
  proposals: ProposalMetrics;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export async function getTenantMetrics(ctx: TenantContext): Promise<TenantMetrics> {
  const [llm] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      failedCalls: sql<number>`count(*) filter (where ${llmCalls.error} is not null)::int`,
      inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)::int`,
      costUsd: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)::text`,
      avgLatencyMs: sql<number>`coalesce(round(avg(${llmCalls.latencyMs})), 0)::int`,
    })
    .from(llmCalls)
    .where(tenantScope(ctx, llmCalls.tenantId));

  const [reqs] = await db
    .select({
      total: sql<number>`count(*)::int`,
      needsReview: sql<number>`count(*) filter (where ${requirements.status} = 'needs_review')::int`,
    })
    .from(requirements)
    .where(tenantScope(ctx, requirements.tenantId));

  const [props] = await db
    .select({
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) filter (where ${proposals.status} = 'pending')::int`,
      applied: sql<number>`count(*) filter (where ${proposals.status} = 'applied')::int`,
      failed: sql<number>`count(*) filter (where ${proposals.status} = 'failed')::int`,
      rejected: sql<number>`count(*) filter (where ${proposals.status} = 'rejected')::int`,
    })
    .from(proposals)
    .where(tenantScope(ctx, proposals.tenantId));

  const requirementTotal = reqs?.total ?? 0;
  const needsReview = reqs?.needsReview ?? 0;

  const applied = props?.applied ?? 0;
  const failed = props?.failed ?? 0;
  const rejected = props?.rejected ?? 0;
  /**
   * A proposal the connector refused still counts as approved: a human said
   * yes, and the CRM said no. Folding those into the rejection rate would
   * misattribute a system failure to human judgement.
   */
  const decided = applied + failed + rejected;

  return {
    llm: {
      calls: llm?.calls ?? 0,
      failedCalls: llm?.failedCalls ?? 0,
      inputTokens: llm?.inputTokens ?? 0,
      outputTokens: llm?.outputTokens ?? 0,
      costUsd: llm?.costUsd ?? "0",
      avgLatencyMs: llm?.avgLatencyMs ?? 0,
    },
    requirements: {
      total: requirementTotal,
      needsReview,
      needsReviewRate: ratio(needsReview, requirementTotal),
    },
    proposals: {
      total: props?.total ?? 0,
      pending: props?.pending ?? 0,
      applied,
      failed,
      rejected,
      approvalRate: ratio(applied + failed, decided),
      rejectionRate: ratio(rejected, decided),
    },
  };
}
