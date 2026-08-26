import { desc } from "drizzle-orm";
import type { TenantContext } from "@veleiro/shared";

import { db, describeDbError } from "../client";
import { llmCalls } from "../schema";
import { tenantScope } from "./context";

export type LlmCall = typeof llmCalls.$inferSelect;

export interface RecordLlmCallInput {
  agent: string;
  promptVersion: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Decimal string from `estimateCost`, never a float. */
  costUsd: string;
  latencyMs: number;
  rawResponse: unknown;
  /** Null on success. Set for every failed call - rule 3 covers those too. */
  error: string | null;
}

export type RecordLlmCallResult =
  | { ok: true; id: string }
  | { ok: false; error: Error };

/**
 * The only writer of `llm_calls`.
 *
 * Takes `TenantContext` first like every repository (CLAUDE.md rule 2). There
 * is no untenanted variant on purpose: `llm_calls.tenant_id` is NOT NULL with a
 * foreign key, so "which tenant paid for this call" is always answerable.
 *
 * Returns a result rather than throwing because its caller - the instrumented
 * client - has to decide what a lost audit row means, and that decision is not
 * this function's to make.
 */
export async function recordLlmCall(
  ctx: TenantContext,
  input: RecordLlmCallInput,
): Promise<RecordLlmCallResult> {
  try {
    const rows = await db
      .insert(llmCalls)
      .values({
        tenantId: ctx.tenantId,
        agent: input.agent,
        promptVersion: input.promptVersion,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costUsd: input.costUsd,
        latencyMs: input.latencyMs,
        rawResponse: input.rawResponse,
        error: input.error,
      })
      .returning({ id: llmCalls.id });

    const inserted = rows[0];
    /* c8 ignore next 3 */
    if (inserted === undefined) {
      return { ok: false, error: new Error("insert into llm_calls returned no row") };
    }

    return { ok: true, id: inserted.id };
  } catch (cause) {
    return { ok: false, error: describeDbError(cause) };
  }
}

/**
 * Reads for the Phase 7 metrics panel, and for the tests that assert rule 3 is
 * actually honoured. Tenant-scoped like everything else here.
 */
export async function listLlmCalls(
  ctx: TenantContext,
  limit = 50,
): Promise<LlmCall[]> {
  return db
    .select()
    .from(llmCalls)
    .where(tenantScope(ctx, llmCalls.tenantId))
    .orderBy(desc(llmCalls.createdAt))
    .limit(limit);
}
