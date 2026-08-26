import type { LlmUsage } from "./types";

/**
 * Turns token counts into the value stored in `llm_calls.cost_usd`.
 *
 * The rate table is data, not a hardcoded zero, so the column stays honest if a
 * paid model is ever configured. Right now every entry is 0 because the project
 * runs on the Groq free tier and CLAUDE.md requires it to cost $0 - that is the
 * real number, not a placeholder.
 *
 * If this account ever moves to a paid plan, the fix is to put the published
 * per-million rates in the table below. Nothing else changes.
 */

export interface ModelRate {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

const FREE = { inputPerMillionUsd: 0, outputPerMillionUsd: 0 } as const;

const RATES: Record<string, ModelRate> = {
  "openai/gpt-oss-120b": FREE,
  "openai/gpt-oss-20b": FREE,
};

/** `numeric(12, 6)` in the schema, so six decimals is the exact representation. */
const COST_DECIMALS = 6;

export interface CostEstimate {
  /** A decimal string, not a float: this is money, and Drizzle stores numeric as text. */
  costUsd: string;
  /** False when the model is absent from the rate table. */
  known: boolean;
}

/**
 * Warn once per unknown model rather than on every call - an eval run makes
 * hundreds of these and a per-call warning would bury the output.
 */
const warnedModels = new Set<string>();

export function estimateCost(model: string, usage: LlmUsage): CostEstimate {
  const rate = RATES[model];

  if (rate === undefined) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      console.warn(
        `[pricing] no rate table entry for model "${model}". Recording cost_usd as 0. ` +
          `Add it to RATES in src/llm/pricing.ts if this model is not free.`,
      );
    }
    // Zero, not a guess. An invented figure in a column named cost_usd is worse
    // than a zero that the warning above explains.
    return { costUsd: (0).toFixed(COST_DECIMALS), known: false };
  }

  const cost =
    (usage.inputTokens / 1_000_000) * rate.inputPerMillionUsd +
    (usage.outputTokens / 1_000_000) * rate.outputPerMillionUsd;

  return { costUsd: cost.toFixed(COST_DECIMALS), known: true };
}
