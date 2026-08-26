import type { TenantContext } from "@veleiro/shared";

import { SMOKE_PROMPT } from "../agents/prompts/smoke.v1";
import { pool } from "../db/client";
import { listLlmCalls } from "../db/repositories/llm-calls";
import { SEED } from "../db/seed";
import { env } from "../env";
import { createAgentLlmClient } from "./factory";
import { describeLlmFailure } from "./types";

/**
 * `npm run llm:smoke` - one real call to the configured provider.
 *
 * Deliberately a script and not a test. The test suite has to stay offline,
 * free and deterministic; this is the thing that proves the wire format is
 * right against the actual endpoint, which no fake client can tell you. Run it
 * by hand when the provider or the model changes.
 *
 * It leaves a real `llm_calls` row behind, and prints it back, because the row
 * is the point as much as the answer is.
 */
async function main(): Promise<number> {
  const ctx: TenantContext = {
    tenantId: SEED.northwind.id,
    userId: SEED.northwind.users[0].id,
  };

  console.log(`[smoke] endpoint ${env.LLM_BASE_URL}`);
  console.log(`[smoke] model    ${env.LLM_MODEL}`);
  console.log(`[smoke] prompt   ${SMOKE_PROMPT.version}`);

  const client = createAgentLlmClient({
    ctx,
    agent: "smoke",
    promptVersion: SMOKE_PROMPT.version,
  });

  const result = await client.complete({
    messages: [
      { role: "system", content: SMOKE_PROMPT.system },
      {
        role: "user",
        content: "Name one field a sales team usually needs on an Opportunity record.",
      },
    ],
    maxTokens: 200,
  });

  if (!result.ok) {
    console.error(`[smoke] FAILED: ${describeLlmFailure(result.error)}`);

    if (result.error.kind === "not_logged") {
      console.error(
        `[smoke] the model answered but the llm_calls row could not be written. ` +
          `If this is a foreign key error, the database is not seeded: npm run db:seed`,
      );
    }

    return 1;
  }

  console.log(`[smoke] answer   ${result.value.content ?? "(empty)"}`);
  console.log(
    `[smoke] usage    ${result.value.usage.inputTokens} in / ` +
      `${result.value.usage.outputTokens} out, ${result.value.latencyMs}ms`,
  );

  const [row] = await listLlmCalls(ctx, 1);
  if (row === undefined) {
    console.error("[smoke] FAILED: the call succeeded but llm_calls is empty");
    return 1;
  }

  console.log(
    `[smoke] recorded llm_calls row ${row.id}\n` +
      `          agent=${row.agent} prompt_version=${row.promptVersion} ` +
      `model=${row.model}\n` +
      `          tokens=${row.inputTokens}/${row.outputTokens} ` +
      `cost_usd=${row.costUsd} latency_ms=${row.latencyMs}`,
  );

  return 0;
}

process.exitCode = await main();
await pool.end();
