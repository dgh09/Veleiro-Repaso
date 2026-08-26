import type { TenantContext } from "@veleiro/shared";

import { db } from "../db/client";
import { projects, tenants, users } from "../db/schema";

/**
 * The tenant the eval harness runs as.
 *
 * A dedicated tenant, not one of the demo ones, for two reasons. Evaluation
 * traffic would otherwise sit in the same `llm_calls` rows as a consultant's
 * real work and distort the Phase 7 cost metrics; and eighteen synthetic
 * transcripts appearing in the demo UI would bury the two that a demo is about.
 *
 * Direct inserts rather than repository calls, deliberately: this creates a
 * tenant, and the tenant-scoped repository layer has no such operation by
 * design - it exists to make cross-tenant access impossible, which means it
 * cannot be the thing that brings a tenant into being. Same category as
 * `db/seed.ts`.
 */
export const EVAL_TENANT = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Veleiro Evaluation Harness",
  slug: "evals",
  userId: "33333333-0000-4000-8000-000000000001",
  userName: "Eval Runner",
  userEmail: "evals@veleiro.test",
  projectId: "33333333-2222-4222-8222-000000000001",
  projectName: "Golden dataset",
  clientName: "Synthetic",
} as const;

export const EVAL_CONTEXT: TenantContext = {
  tenantId: EVAL_TENANT.id,
  userId: EVAL_TENANT.userId,
};

/** Idempotent, so a run never depends on whether a previous run happened. */
export async function ensureEvalTenant(): Promise<void> {
  await db
    .insert(tenants)
    .values({ id: EVAL_TENANT.id, name: EVAL_TENANT.name, slug: EVAL_TENANT.slug })
    .onConflictDoNothing();

  await db
    .insert(users)
    .values({
      id: EVAL_TENANT.userId,
      tenantId: EVAL_TENANT.id,
      name: EVAL_TENANT.userName,
      email: EVAL_TENANT.userEmail,
    })
    .onConflictDoNothing();

  await db
    .insert(projects)
    .values({
      id: EVAL_TENANT.projectId,
      tenantId: EVAL_TENANT.id,
      name: EVAL_TENANT.projectName,
      clientName: EVAL_TENANT.clientName,
    })
    .onConflictDoNothing();
}
